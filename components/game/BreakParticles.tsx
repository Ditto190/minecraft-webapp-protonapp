'use client';

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BoxGeometry, Mesh, Vector3, type Group, type Material } from 'three';
import { ATLAS_CELL_RATIO, ATLAS_COLS, ATLAS_PAD_RATIO, ATLAS_ROWS, BLOCKS } from '@/lib/blocks';
import { breakParticles, getActiveWorld, type BreakParticleEvent } from '@/lib/game';
import { DEATH_SMOKE_TILE } from '@/lib/mobs';
import { getAtlasMaterials, tilePx } from '@/lib/textures';
import { useGameStore } from '@/lib/store';
import { useRendererKind } from './renderer-kind';

const POOL_SIZE = 48; // 32 供破坏碎块 + 余量供死亡白烟（一次死亡 10 粒，不与挖掘抢池）
const PARTICLES_PER_BREAK = 10;
const LIFE = 0.85; // 秒
const GRAVITY = 22;
const BASE_SIZE = 0.12;

interface Particle {
  mesh: Mesh;
  geo: BoxGeometry;
  vel: Vector3;
  spin: Vector3;
  age: number;
  active: boolean;
  /** 本次激活的基础尺寸（shrink 动画在此基础上缩放） */
  size: number;
  /** 白烟变体（生物死亡）：白色半透明、无重力上飘、先膨后缩；false = 普通破坏碎块 */
  smoke: boolean;
}

/** 模块级粒子池：帧循环里直接改（与 digState/touchInput 同模式） */
const particlePool: Particle[] = [];
/** 空闲槽索引栈：spawn 时 O(1) 取槽，粒子死亡时 O(1) 回收 */
const freeIndices: number[] = [];
/** 当前活跃粒子索引列表：useFrame 只遍历活跃粒子 */
const activeIndices: number[] = [];
/** 池共享材质：图集碎块 / 白烟（池初始化时写入；spawn 按事件类型切换 mesh.material，卸载时释放） */
let sharedMatRef: Material | null = null;
let smokeMatRef: Material | null = null;

/** BoxGeometry 每面 4 顶点（uv 顺序 (0,1)(1,1)(0,0)(1,0)），按图集子区重写 24 顶点 UV */
function setGeoUv(geo: BoxGeometry, u0: number, vTop: number, u1: number, vBottom: number): void {
  const uv = geo.attributes.uv;
  for (let f = 0; f < 6; f++) {
    uv.setXY(f * 4 + 0, u0, vTop);
    uv.setXY(f * 4 + 1, u1, vTop);
    uv.setXY(f * 4 + 2, u0, vBottom);
    uv.setXY(f * 4 + 3, u1, vBottom);
  }
  uv.needsUpdate = true;
}

/** 方块破坏时的碎块粒子：每粒子独立几何（激活时重写 UV 取图集子区），全池共享一份图集材质（不再克隆 32 份图集，省 ~147MB 显存），落地反弹后静止消失；
 *  生物死亡白烟变体：tile === DEATH_SMOKE_TILE 的事件切换为白色半透明材质，无重力上飘、先膨后缩（MC 尸体消散 poof） */
export function BreakParticles() {
  const groupRef = useRef<Group>(null);
  const kind = useRendererKind();

  // 初始化粒子池（贴图就绪后），卸载时释放
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    let cancelled = false;
    void getAtlasMaterials(kind).then((mats) => {
      if (cancelled) return;
      sharedMatRef = mats.basic({ map: mats.texture, transparent: true });
      // 白烟共享材质：近白半透明、不写深度（团状叠加不互相切块）；所有白烟粒子共用（渐隐用缩放近似，见帧循环）
      smokeMatRef = mats.basic({ color: '#f5f5f5', transparent: true, opacity: 0.5, depthWrite: false });
      for (let i = 0; i < POOL_SIZE; i++) {
        const geo = new BoxGeometry(1, 1, 1);
        const mesh = new Mesh(geo, sharedMatRef);
        mesh.visible = false;
        group.add(mesh);
        particlePool.push({ mesh, geo, vel: new Vector3(), spin: new Vector3(), age: 0, active: false, size: BASE_SIZE, smoke: false });
        freeIndices.push(i);
      }
    });
    return () => {
      cancelled = true;
      for (const p of particlePool) {
        p.mesh.removeFromParent();
        p.geo.dispose();
      }
      particlePool.length = 0;
      sharedMatRef?.dispose();
      smokeMatRef?.dispose();
      sharedMatRef = null;
      smokeMatRef = null;
      freeIndices.length = 0;
      activeIndices.length = 0;
    };
  }, [kind]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const world = getActiveWorld();

    // 设置里关闭粒子：丢弃破坏事件且不再更新（MC 粒子开关）
    if (!useGameStore.getState().settings.particles) {
      breakParticles.length = 0;
      return;
    }

    // 消费破坏事件，每次激活最多 PARTICLES_PER_BREAK 个粒子
    while (freeIndices.length > 0 && breakParticles.length > 0) {
      const e = breakParticles.shift()!;
      spawn(e);
    }

    // 只更新活跃粒子；无活跃时跳过物理循环
    if (activeIndices.length === 0) return;
    for (let i = activeIndices.length - 1; i >= 0; i--) {
      const idx = activeIndices[i];
      const p = particlePool[idx];
      p.age += dt;
      if (p.age >= LIFE) {
        p.active = false;
        p.mesh.visible = false;
        activeIndices.splice(i, 1);
        freeIndices.push(idx);
        continue;
      }
      if (p.smoke) {
        // 白烟：无重力上飘 + 轻阻尼；先膨后缩（t→1 缩到 0 代替逐粒子透明渐隐——共享材质不能单独调 opacity）
        p.vel.multiplyScalar(Math.max(0, 1 - 1.2 * dt));
        p.mesh.position.x += p.vel.x * dt;
        p.mesh.position.y += p.vel.y * dt;
        p.mesh.position.z += p.vel.z * dt;
        const t = p.age / LIFE;
        p.mesh.scale.setScalar(p.size * (0.8 + t * 0.8) * (1 - t * t));
        continue;
      }
      p.vel.y -= GRAVITY * dt;
      const nx = p.mesh.position.x + p.vel.x * dt;
      let ny = p.mesh.position.y + p.vel.y * dt;
      const nz = p.mesh.position.z + p.vel.z * dt;
      if (world && p.vel.y <= 0) {
        // 粒子底部进入实心方块：反弹衰减，低速时停在地表并加摩擦
        const groundY = Math.floor(ny - p.size / 2);
        const below = BLOCKS[world.getBlock(Math.floor(nx), groundY, Math.floor(nz))];
        if (below?.solid) {
          ny = groundY + 1 + p.size / 2;
          p.vel.y *= -0.4;
          p.vel.x *= 0.5;
          p.vel.z *= 0.5;
          if (Math.abs(p.vel.y) < 1.5) {
            p.vel.y = 0;
            const f = Math.max(0, 1 - 8 * dt);
            p.vel.x *= f;
            p.vel.z *= f;
            p.spin.multiplyScalar(f);
          }
        }
      }
      p.mesh.position.set(nx, ny, nz);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      // 生命周期末段缩小消失
      p.mesh.scale.setScalar(p.size * (1 - (p.age / LIFE) * 0.5));
    }
  });

  return <group ref={groupRef} />;
}

function spawn(e: BreakParticleEvent): void {
  // 白烟变体（生物死亡，mobs.ts 推 DEATH_SMOKE_TILE）：事件坐标为生物脚部中心，粒子在身体范围内散布上飘
  const smoke = e.tile === DEATH_SMOKE_TILE;
  const col = e.tile % ATLAS_COLS;
  const row = Math.floor(e.tile / ATLAS_COLS);
  let spawned = 0;
  while (spawned < PARTICLES_PER_BREAK && freeIndices.length > 0) {
    const idx = freeIndices.pop()!;
    activeIndices.push(idx);
    const p = particlePool[idx];
    p.active = true;
    p.age = 0;
    p.smoke = smoke;
    p.size = BASE_SIZE * (0.8 + Math.random() * 0.5); // 尺寸随机，碎块有大有小
    p.mesh.visible = true;
    if (sharedMatRef && smokeMatRef) p.mesh.material = smoke ? smokeMatRef : sharedMatRef; // 池复用：材质按本次事件类型切回/切换
    if (smoke) {
      p.mesh.position.set(
        e.x + (Math.random() - 0.5) * 0.7,
        e.y + 0.2 + Math.random() * 1.4,
        e.z + (Math.random() - 0.5) * 0.7,
      );
      p.vel.set((Math.random() - 0.5) * 0.8, 0.9 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8);
      p.spin.set(0, 0, 0);
      p.mesh.rotation.set(0, 0, 0);
      p.mesh.scale.setScalar(p.size * 0.8);
      spawned++;
      continue;
    }
    p.mesh.position.set(
      e.x + 0.25 + Math.random() * 0.5,
      e.y + 0.25 + Math.random() * 0.5,
      e.z + 0.25 + Math.random() * 0.5,
    );
    p.vel.set((Math.random() - 0.5) * 3, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 3);
    p.spin.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 0);
    p.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    p.mesh.scale.setScalar(p.size);
    // 每颗粒取贴图的随机 1/4 局部（MC 的 4×4 碎块样式）：重写本粒子几何的 UV（几何独立、材质共享）
    const crop = tilePx / 4;
    const cx = Math.floor(Math.random() * (tilePx - crop)) / tilePx;
    const cy = Math.floor(Math.random() * (tilePx - crop)) / tilePx;
    const cw = crop / tilePx;
    const u0 = (col * ATLAS_CELL_RATIO + ATLAS_PAD_RATIO + cx) / (ATLAS_COLS * ATLAS_CELL_RATIO);
    const u1 = (col * ATLAS_CELL_RATIO + ATLAS_PAD_RATIO + cx + cw) / (ATLAS_COLS * ATLAS_CELL_RATIO);
    const vTop = 1 - (row * ATLAS_CELL_RATIO + ATLAS_PAD_RATIO + cy) / (ATLAS_ROWS * ATLAS_CELL_RATIO);
    const vBottom = 1 - (row * ATLAS_CELL_RATIO + ATLAS_PAD_RATIO + cy + cw) / (ATLAS_ROWS * ATLAS_CELL_RATIO);
    setGeoUv(p.geo, u0, vTop, u1, vBottom);
    spawned++;
  }
}
