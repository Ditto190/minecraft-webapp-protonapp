'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { BoxGeometry, Group, Mesh, Vector3, type Material } from 'three';
import { playerPosition } from '@/lib/game';
import { arrows, clearMobs, mobs } from '@/lib/mobs';
import { PROFESSION_INFO } from '@/lib/trading';
import { useGameStore } from '@/lib/store';
import { getAtlasMaterials, type AtlasMaterials } from '@/lib/textures';
import { MobInstancePools } from './mob-instancing';
import { useRendererKind, type RendererKind } from './renderer-kind';

// ——— 投射物几何（箭/火球等逐个体网格，量小不实例化；生物部件几何见 mob-instancing.ts） ———
const arrowGeo = new BoxGeometry(0.05, 0.05, 0.5);
const fireballGeo = new BoxGeometry(0.22, 0.22, 0.22);

type MobMats = Record<string, Material>;

/**
 * 生物材质表模块级缓存（key = 渲染器类型，材质参数全部由渲染器类型 + 固定颜色表决定）。
 * 取舍：生物材质是无纹理的纯色 Lambert（~80 个/套，GPU 占用极小），缓存常驻页面生命周期、
 * 不随进/出世界 dispose —— 换取同局同种生物部件共享、反复进出世界零重建
 * （此前每次进世界新建一套且从不 dispose，GL program 会累积）。
 * 几何不受影响：部件几何本就是模块级共享常量（mob-instancing.ts MOB_GEOS），与尺寸无关的材质缓存不改变这一现状。
 */
const mobMatsCache = new Map<RendererKind, MobMats>();

/** 取生物材质表：按渲染器类型缓存复用，未命中才构建 */
function getMobMats(kind: RendererKind, mats: AtlasMaterials): MobMats {
  let cached = mobMatsCache.get(kind);
  if (!cached) {
    cached = buildMobMats(mats);
    mobMatsCache.set(kind, cached);
  }
  return cached;
}

/** 按渲染器类型构建生物材质表 */
function buildMobMats(mats: AtlasMaterials): MobMats {
  const l = (color: string) => mats.lambert({ color });
  return {
    zombieSkin: l('#2e7d32'),
    zombieShirt: l('#2a4a7f'),
    zombiePants: l('#3a3a5e'),
    bone: l('#d8d8d8'),
    boneDark: l('#a8a8a8'),
    spider: l('#1a1a1a'),
    creeper: l('#3f9e3f'),
    creeperDark: l('#1a3d1a'),
    pig: l('#e8a0a8'),
    pigDark: l('#d4838c'),
    cow: l('#6b4a2f'),
    cowLight: l('#d8cfc0'),
    mooshroom: l('#a03028'), // 蘑菇牛红身（MC 红蘑菇牛）
    mooshroomSpot: l('#e8e0d8'),
    piglinSkin: l('#c98a8a'), // 僵尸猪灵：腐粉
    piglinFlesh: l('#e0a69a'), // 猪灵：粉棕
    piglinDark: l('#9a6a5a'),
    brute: l('#6a5a50'), // 蛮兵：深褐
    bruteDark: l('#4a3e38'),
    piglinRot: l('#7f9e5f'), // 僵尸猪灵：尸斑绿
    goldSword: l('#e8c840'),
    blaze: l('#e8b830'), // 烈焰人明黄
    blazeRod: l('#c07818'), // 烈焰棒橙
    wither: l('#1a1a1a'), // 凋灵骷髅炭黑
    ghast: l('#f0f0f0'), // 恶魂雪白
    ghastTear: l('#c8b8d8'),
    // 快乐恶魂链（1.21.6）：小恶魂奶白、面部深色、鞍具皮革棕与护目镜深色
    ghastling: l('#f5f0e4'),
    ghastDark: l('#4a4048'),
    harnessLeather: l('#8a5a2b'),
    harnessGoggles: l('#3a2a1a'),
    sheepFace: l('#d8b8a0'),
    wolf: l('#c8c8c8'),
    wolfDark: l('#909090'),
    collar: l('#c03030'),
    enderman: l('#141414'),
    enderEyes: l('#b050e0'),
    witherBody: l('#242028'),
    dragonBody: l('#171221'),
    dragonWing: l('#2b2340'),
    dragonEye: l('#c860ff'),
    shulkerShell: l('#8a6a9a'),
    shulkerTop: l('#a585b5'),
    shulkerBullet: l('#c9a0e8'),
    slimeOuter: l('#7ecb6a'),
    slimeDark: l('#2a5a28'),
    phantomBody: l('#3d4652'), // 幻翼：灰蓝黑
    phantomWing: l('#5a6673'),
    phantomEye: l('#a8e8c0'),
    golemIron: l('#c9c4b8'), // 铁傀儡：铁灰
    golemIronDark: l('#a09a8c'),
    golemVine: l('#5d7a3a'), // 藤蔓斑（MC 铁傀儡青苔纹）
    copperGolem: l('#c06a3a'), // 铜傀儡（1.21.9）：铜本色（与 textures.ts COPPER 一致）
    copperGolemDark: l('#7e3f1e'),
    copperGolemLight: l('#e89a5f'),
    copperGolemEye: l('#f0c040'), // 发光黄眼（MC 铜灯质感）
    chicken: l('#e8e8e8'),
    beak: l('#e8a030'),
    // ——— 1.21.5 群系变种配色（牛/猪/鸡 × 寒带深/热带浅，MC 纯色近似；温带沿用上方原色）———
    cow_cold: l('#4a3524'), // 寒带牛：深褐近黑（MC 寒带牛深色毛）
    cowLight_cold: l('#c8b8a4'),
    cow_warm: l('#8f5a32'), // 热带牛：暖红褐、偏浅（MC 热带牛）
    cowLight_warm: l('#e0c8a8'),
    pig_cold: l('#6e5138'), // 寒带猪：深棕厚毛（MC 寒带猪）
    pigDark_cold: l('#553e2a'),
    pig_warm: l('#d9b285'), // 热带猪：浅沙棕（MC 热带猪）
    pigDark_warm: l('#b8925f'),
    chicken_cold: l('#3d4149'), // 寒带鸡：深灰近黑羽（MC 寒带鸡）
    comb_cold: l('#8a2020'), // 寒带鸡冠：暗红
    chicken_warm: l('#b5854e'), // 热带鸡：暖棕羽（MC 热带鸡）
    comb_warm: l('#c03828'), // 热带鸡冠：亮红
    robe: l('#7a5230'),
    villagerSkin: l('#b58a6a'),
    arrow: l('#a8a8a8'),
    // 受击红闪罩壳：半透明红、无光照（夜里也可见，对齐 Java hurt flash）、不写深度（贴着本体避免 z-fight）
    hurtFlash: mats.basic({ color: '#ff2a2a', transparent: true, opacity: 0.45, depthWrite: false }),
    enderEye: l('#2fae5f'), // 末影之眼（绿）
    // 村民职业袍色（交易界面同色）
    ...Object.fromEntries(Object.entries(PROFESSION_INFO).map(([p, info]) => [`robe_${p}`, l(info.robe)])),
    // 羊毛色（羊模型用，MC 分布六色）
    ...Object.fromEntries(['white', 'black', 'gray', 'light_gray', 'brown', 'pink'].map((c) => [`wool_${c}`, l({ white: '#e8e8e8', black: '#1a1a1a', gray: '#5a5a5a', light_gray: '#a0a0a0', brown: '#6b4a2f', pink: '#f0a8b8' }[c] ?? '#e8e8e8')])),
  };
}

const arrowForward = new Vector3(0, 0, 1);
const arrowDir = new Vector3();
/** 帧循环复用的去重集合（避免每帧分配） */
const seenArrowsScratch = new Set<number>();

/**
 * 生物渲染（仅生存模式）。生物网格全部实例化：同种同变体的每个部件层一个 InstancedMesh，
 * 每帧按生物位姿合成实例矩阵（位姿/红闪/死亡动画/距离门逻辑见 mob-instancing.ts），
 * draw call 从 O(生物数×部件数) 降到 O(变体数×部件层数)；AI 已收口到 lib/sim.ts tickWorld。
 */
export function Mobs() {
  const groupRef = useRef<Group>(null);
  const poolsRef = useRef<MobInstancePools | null>(null);
  const arrowMeshMap = useRef(new Map<number, Mesh>());
  const [mobMats, setMobMats] = useState<MobMats | null>(null);
  const kind = useRendererKind();

  // 按渲染器类型取材质表（模块级缓存，进出世界不重建）；卸载（退出世界）时清空怪物与实例池
  useEffect(() => {
    void getAtlasMaterials(kind).then((m) => setMobMats(getMobMats(kind, m)));
    const arrowMeshes = arrowMeshMap.current;
    return () => {
      clearMobs();
      poolsRef.current?.dispose();
      poolsRef.current = null;
      arrowMeshes.clear();
    };
  }, [kind]);

  // 生物 AI 已收口到 lib/sim.ts 的统一模拟循环（tickWorld）；本组件只负责渲染网格同步
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    // 暂停时冻结网格同步（画面停在暂停前最后一帧；AI 由 sim 统一暂停）
    if (useGameStore.getState().paused) return;

    // 同步生物实例（材质表就绪后才建池；渲染器切换导致材质表换对象时重建池）
    if (mobMats) {
      let pools = poolsRef.current;
      if (pools && pools.materials !== mobMats) {
        pools.dispose();
        pools = null;
        poolsRef.current = null;
      }
      if (!pools) {
        pools = new MobInstancePools(mobMats);
        group.add(pools.root);
        poolsRef.current = pools;
      }
      pools.sync(mobs, playerPosition.x, playerPosition.z, performance.now());

      // 同步箭网格
      const seenArrows = seenArrowsScratch;
      seenArrows.clear();
      for (const a of arrows) {
        seenArrows.add(a.id);
        let mesh = arrowMeshMap.current.get(a.id);
        if (!mesh) {
          // 烈焰人火球：橙色大球；恶魂爆裂球：淡紫大球；末影之眼：绿色小球；潜影弹：紫色小球；箭：灰色小条
          const isBall = a.kind === 'fireball' || a.kind === 'ghast' || a.kind === 'eye' || a.kind === 'shulker';
          mesh = new Mesh(isBall ? fireballGeo : arrowGeo, a.kind === 'ghast' ? mobMats.ghastTear : a.kind === 'fireball' ? mobMats.blaze : a.kind === 'eye' ? mobMats.enderEye : a.kind === 'shulker' ? mobMats.shulkerBullet : mobMats.arrow);
          group.add(mesh);
          arrowMeshMap.current.set(a.id, mesh);
        }
        mesh.position.set(a.x, a.y, a.z);
        arrowDir.set(a.vx, a.vy, a.vz).normalize();
        mesh.quaternion.setFromUnitVectors(arrowForward, arrowDir);
      }
      for (const [id, mesh] of arrowMeshMap.current) {
        if (!seenArrows.has(id)) {
          mesh.removeFromParent();
          arrowMeshMap.current.delete(id);
        }
      }
    }
  });

  return <group ref={groupRef} />;
}
