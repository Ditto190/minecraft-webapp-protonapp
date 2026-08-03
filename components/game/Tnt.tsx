'use client';

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Mesh, type Group, type Material } from 'three';
import { BLOCK_BY_KEY } from '@/lib/blocks';
import { getActiveWorld, playerPosition } from '@/lib/game';
import { buildBlockGeometry } from '@/lib/mesher';
import { useGameStore } from '@/lib/store';
import { getAtlasMaterials } from '@/lib/textures';
import { clearTnt, primedTnt, tickTnt } from '@/lib/tnt';
import { toGeometry } from './ChunkMesh';
import { useRendererKind } from './renderer-kind';

/** 帧循环复用的去重集合（避免每帧分配） */
const seenScratch = new Set<number>();

/** 引信中的 TNT 实体：重力缓落 + 白闪引信（越近爆点闪得越快）+ 到期爆炸 */
export function Tnt() {
  const groupRef = useRef<Group>(null);
  const meshMap = useRef(new Map<number, Mesh>());
  const geoRef = useRef<ReturnType<typeof toGeometry>>(null);
  /** TNT 方块材质（单方块几何为 atlas 终值 UV 旧约定——不能共用 chunk 的
   *  materials.solid（块单位 UV + aTile 注入），同 ItemDrops 走 lambert 工厂自建） */
  const matRef = useRef<Material | null>(null);
  const kind = useRendererKind();

  useEffect(() => {
    let disposed = false;
    void getAtlasMaterials(kind).then((m) => {
      if (disposed) return;
      matRef.current = m.lambert({ map: m.texture, alphaTest: 0.5, vertexColors: true });
      geoRef.current = toGeometry(buildBlockGeometry(BLOCK_BY_KEY.tnt.id));
    });
    const meshes = meshMap.current;
    return () => {
      disposed = true;
      clearTnt();
      for (const mesh of meshes.values()) {
        mesh.removeFromParent();
      }
      meshes.clear();
      matRef.current?.dispose();
      matRef.current = null;
      geoRef.current?.dispose();
      geoRef.current = null;
    };
  }, [kind]);

  useFrame((_, delta) => {
    const world = getActiveWorld();
    const group = groupRef.current;
    if (!world || !group || !matRef.current) return;
    const dt = Math.min(delta, 0.05);
    // 暂停（指针解锁/Esc）时引信冻结，与物理/生物一致
    if (!useGameStore.getState().paused) {
      tickTnt(world, dt, playerPosition, (dmg) => {
        if (!useGameStore.getState().dead) useGameStore.getState().damagePlayer(dmg);
      });
    }

    // 同步 mesh：新增/更新/删除；引信后段加速白闪
    const seen = seenScratch;
    seen.clear();
    for (const t of primedTnt) {
      seen.add(t.id);
      let mesh = meshMap.current.get(t.id);
      if (!mesh && geoRef.current && matRef.current) {
        mesh = new Mesh(geoRef.current, matRef.current);
        mesh.scale.setScalar(0.98);
        group.add(mesh);
        meshMap.current.set(t.id, mesh);
      }
      if (!mesh) continue;
      mesh.position.set(t.x - 0.49, t.y, t.z - 0.49);
      // MC：引信后半段间隔白闪，越接近爆炸闪得越快
      const interval = t.fuse > 2 ? 0.4 : 0.15;
      mesh.visible = Math.floor(t.fuse / interval) % 2 === 0 || t.fuse > 3.5;
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
