'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Mesh, MeshBasicMaterial, type BufferGeometry, type Group } from 'three';
import { armorDefOf } from '@/lib/armor';
import { getActiveWorld, playerPosition } from '@/lib/game';
import { clearDrops, itemDrops, tickDrops, type ItemDrop } from '@/lib/items';
import { materialTile } from '@/lib/materials';
import { buildBlockGeometry, buildTileGeometry } from '@/lib/mesher';
import { useGameStore } from '@/lib/store';
import { getAtlasMaterials, type AtlasMaterials } from '@/lib/textures';
import { TOOLS } from '@/lib/tools';
import { toGeometry } from './ChunkMesh';
import { useRendererKind } from './renderer-kind';
import { hasEnchants } from './slotDisplay';

/** 帧循环复用的去重集合（避免每帧分配） */
const seenScratch = new Set<number>();

/** 掉落物渲染与物理驱动：小方块旋转 + 上下浮动，几何按内容类型缓存 */
export function ItemDrops() {
  const groupRef = useRef<Group>(null);
  const meshMap = useRef(new Map<number, Mesh>());
  const geoCache = useRef(new Map<string, BufferGeometry>());
  /** 附魔光泽材质（additive 紫，全部附魔掉落物共享一份，useFrame 里整体脉动） */
  const glintMat = useRef<MeshBasicMaterial | null>(null);
  const kind = useRendererKind();
  const [materials, setMaterials] = useState<AtlasMaterials | null>(null);

  useEffect(() => {
    void getAtlasMaterials(kind).then(setMaterials);
    const glint = new MeshBasicMaterial({ color: '#b26bff', transparent: true, opacity: 0.3, blending: AdditiveBlending, depthWrite: false, fog: false });
    glintMat.current = glint;
    const meshes = meshMap.current;
    const geos = geoCache.current;
    return () => {
      clearDrops();
      glint.dispose();
      glintMat.current = null;
      meshes.clear();
      for (const g of geos.values()) g.dispose(); // 几何缓存卸载时释放 GPU 资源
      geos.clear();
    };
  }, [kind]);

  useFrame((state, delta) => {
    const world = getActiveWorld();
    const group = groupRef.current;
    if (!world || !group || !materials) return;
    if (useGameStore.getState().paused) return;
    const dt = Math.min(delta, 0.05);

    tickDrops(world, dt, playerPosition, (drop) => {
      const s = useGameStore.getState();
      if (drop.drop.kind === 'block') {
        const left = s.addStack({ kind: 'block', id: drop.drop.blockId }, drop.count);
        if (left === 0) return true;
        drop.count = left; // 背包满：剩下的留在原地
        return false;
      }
      if (drop.drop.kind === 'material') {
        const left = s.addStack({ kind: 'material', material: drop.drop.material }, drop.count);
        if (left === 0) return true;
        drop.count = left;
        return false;
      }
      if (drop.drop.kind === 'tool') {
        return s.addTool(drop.drop.tool, drop.durability, drop.ench);
      }
      return s.addArmor(drop.drop.piece, drop.durability, drop.drop.material, drop.ench);
    });

    // 附魔光泽整体呼吸：透明度 + 色相缓慢摆动（共享材质，一次更新全场景生效）
    const glint = glintMat.current;
    if (glint) {
      const t = state.clock.elapsedTime;
      glint.opacity = 0.24 + Math.sin(t * 2.2) * 0.1;
      glint.color.setHSL(0.76 + Math.sin(t * 0.8) * 0.03, 0.85, 0.62);
    }

    // 同步 mesh：新增/更新/删除
    const seen = seenScratch;
    seen.clear();
    for (const d of itemDrops) {
      seen.add(d.id);
      let mesh = meshMap.current.get(d.id);
      if (!mesh) {
        const geo = geometryForDrop(d, geoCache.current);
        if (!geo) continue;
        mesh = new Mesh(geo, materials.solid);
        mesh.scale.setScalar(0.25);
        // 附魔物品：略大的紫色 additive 罩层（复用同一几何，子节点随主体旋转/浮动）
        if (glint && hasEnchants(d.ench)) {
          const glow = new Mesh(geo, glint);
          glow.scale.setScalar(1.12);
          mesh.add(glow);
        }
        group.add(mesh);
        meshMap.current.set(d.id, mesh);
      }
      // 旋转 + 上下浮动（MC 掉落物动画）
      mesh.position.set(d.x, d.y + 0.05 + Math.sin(d.age * 2.5) * 0.06, d.z);
      mesh.rotation.y = d.age * 1.8;
    }
    for (const [id, mesh] of meshMap.current) {
      if (!seen.has(id)) {
        mesh.removeFromParent();
        meshMap.current.delete(id);
      }
    }
  });

  return <group ref={groupRef} />;
}

function geometryForDrop(d: ItemDrop, cache: Map<string, BufferGeometry>): BufferGeometry | null {
  let key: string;
  let build: () => BufferGeometry | null;
  if (d.drop.kind === 'block') {
    const blockId = d.drop.blockId; // 提前取值，TS 无法把窄化带进闭包
    key = `b:${blockId}`;
    build = () => toGeometry(buildBlockGeometry(blockId));
  } else {
    // 工具/材料/装备各自取对应的图标 tile
    const tile =
      d.drop.kind === 'tool'
        ? TOOLS[d.drop.tool].iconTile
        : d.drop.kind === 'material'
          ? materialTile(d.drop.material)
          : armorDefOf(d.drop).iconTile;
    key = `t:${tile}`;
    build = () => toGeometry(buildTileGeometry(tile));
  }
  let geo = cache.get(key);
  if (!geo) {
    const built = build();
    if (!built) return null;
    cache.set(key, built);
    geo = built;
  }
  return geo;
}
