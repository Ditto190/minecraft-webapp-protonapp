import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type Material } from 'three';
import {
  computeMobRenderState,
  INITIAL_CAPACITY,
  MOB_GEOS,
  MobInstancePools,
  partsForVariant,
  variantKeyOf,
} from '../mob-instancing';
import { MOB_DEATH_DURATION, type Mob, type MobType } from '../../../lib/mobs';
import { professionOf } from '../../../lib/trading';

// ——— 测试工具 ———
let nextId = 1;
function fakeMob(p: Partial<Mob> & { type?: MobType } = {}): Mob {
  return {
    id: nextId++,
    type: 'zombie',
    x: 0,
    y: 64,
    z: 0,
    velY: 0,
    hp: 20,
    attackCd: 0,
    onGround: true,
    wanderDir: 0,
    wanderTimer: 0,
    wanderMoving: false,
    fleeTimer: 0,
    fleeFromX: 0,
    fleeFromZ: 0,
    arrowCd: 0,
    ignite: -1,
    ...p,
  };
}

/** 懒建材质表（任意键返回独立材质，hurtFlash/wool/robe 回退路径同样命中） */
function fakeMats(): Record<string, Material> {
  const t: Record<string, Material> = {};
  return new Proxy(t, {
    get: (o, k: string) => (o[k] ??= new MeshBasicMaterial()),
  });
}

const scratch = new Matrix4();
/** 读实例矩阵元素（column-major：12/13/14 为平移，0/1/2 为第一列） */
function el(im: InstancedMesh, i: number) {
  im.getMatrixAt(i, scratch);
  return scratch.elements;
}
function layersOf(pools: MobInstancePools, geoKey: string): InstancedMesh[] {
  return pools.root.children.filter(
    (c): c is InstancedMesh => c instanceof InstancedMesh && c.geometry === MOB_GEOS[geoKey],
  );
}
function flashMeshOf(pools: MobInstancePools): InstancedMesh {
  return layersOf(pools, 'flash')[0];
}

describe('partsForVariant 部件表与原 makeMobMesh 逐点一致', () => {
  it('各类型部件数量', () => {
    const counts: Record<string, number> = {
      zombie: 6, skeleton: 6, creeper: 7, spider: 10, pig: 7, cow: 8, mooshroom: 14,
      zombified_piglin: 8, piglin: 8, piglin_brute: 8, blaze: 5, wither_skeleton: 7,
      enderman: 8, wither: 5, shulker: 2, slime: 4, ender_dragon: 11, ghast: 9,
      chicken: 3, iron_golem: 8, phantom: 6, copper_golem: 10,
    };
    for (const [type, n] of Object.entries(counts)) {
      expect(partsForVariant(type), type).toHaveLength(n);
    }
  });

  it('僵尸部件偏移/几何/材质逐点一致', () => {
    expect(partsForVariant('zombie')).toEqual([
      { geo: 'leg', mat: 'zombiePants', x: -0.13, y: 0.375, z: 0, rz: undefined },
      { geo: 'leg', mat: 'zombiePants', x: 0.13, y: 0.375, z: 0, rz: undefined },
      { geo: 'body', mat: 'zombieShirt', x: 0, y: 1.1, z: 0, rz: undefined },
      { geo: 'armForward', mat: 'zombieSkin', x: -0.34, y: 1.32, z: 0.22, rz: undefined },
      { geo: 'armForward', mat: 'zombieSkin', x: 0.34, y: 1.32, z: 0.22, rz: undefined },
      { geo: 'head', mat: 'zombieSkin', x: 0, y: 1.66, z: 0, rz: undefined },
    ]);
  });

  it('蜘蛛八腿对称分布', () => {
    const legs = partsForVariant('spider').filter((p) => p.geo === 'spiderLeg');
    expect(legs).toHaveLength(8);
    expect(legs[0]).toMatchObject({ x: -0.6, y: 0.3, z: -0.3 });
    expect(legs[7].x).toBe(0.6);
    expect(legs[7].y).toBe(0.3);
    expect(legs[7].z).toBeCloseTo(0.3); // -0.3 + 3*0.2 浮点尾差（与原内联计算同式）
  });

  it('龙翼/幻翼翼膜带固定倾角 rz', () => {
    const dw = partsForVariant('ender_dragon').filter((p) => p.geo === 'dragonWing');
    expect(dw).toHaveLength(2);
    expect(dw[0]).toMatchObject({ x: -2.1, y: 0.7, z: 0.4, rz: 0.5 });
    expect(dw[1]).toMatchObject({ x: 2.1, y: 0.7, z: 0.4, rz: -0.5 });
    const pw = partsForVariant('phantom').filter((p) => p.geo === 'phantomWing');
    expect(pw[0].rz).toBe(0.18);
    expect(pw[1].rz).toBe(-0.18);
  });

  it('羊变体：毛色/剪毛换几何与头高', () => {
    const woolly = partsForVariant('sheep:brown:0');
    expect(woolly).toHaveLength(6);
    expect(woolly[4]).toMatchObject({ geo: 'sheepWool', mat: 'wool_brown', x: 0, y: 0.62, z: 0 });
    expect(woolly[5]).toMatchObject({ geo: 'sheepHead', y: 0.78, z: 0.5 });
    const shorn = partsForVariant('sheep:brown:1');
    expect(shorn[4]).toMatchObject({ geo: 'sheepSlim', mat: 'sheepFace', x: 0, y: 0.5, z: 0 });
    expect(shorn[5]).toMatchObject({ geo: 'sheepHead', y: 0.72, z: 0.5 });
  });

  it('狼变体：驯服加项圈', () => {
    expect(partsForVariant('wolf:0')).toHaveLength(9);
    const tamed = partsForVariant('wolf:1');
    expect(tamed).toHaveLength(10);
    expect(tamed[9]).toMatchObject({ geo: 'collar', mat: 'collar', x: 0, y: 0.62, z: 0.28 });
  });

  it('村民变体：袍色随职业', () => {
    const parts = partsForVariant('villager:farmer');
    expect(parts).toHaveLength(6);
    expect(parts.filter((p) => p.mat === 'robe_farmer')).toHaveLength(4);
    expect(parts[3]).toMatchObject({ geo: 'villagerHead', mat: 'villagerSkin', y: 1.64 });
    expect(parts[4]).toMatchObject({ geo: 'villagerNose', mat: 'villagerSkin', y: 1.52, z: 0.27 });
  });
});

describe('variantKeyOf', () => {
  it('羊按毛色×剪毛、狼按驯服、村民按职业、其余按类型', () => {
    expect(variantKeyOf(fakeMob({ type: 'sheep', woolColor: 'gray', sheared: true }))).toBe('sheep:gray:1');
    expect(variantKeyOf(fakeMob({ type: 'sheep' }))).toBe('sheep:white:0');
    expect(variantKeyOf(fakeMob({ type: 'wolf', tamed: true }))).toBe('wolf:1');
    expect(variantKeyOf(fakeMob({ type: 'zombie' }))).toBe('zombie');
    const v = fakeMob({ type: 'villager' });
    expect(variantKeyOf(v)).toBe(`villager:${professionOf(v.id)}`);
  });

  it('牛/猪/鸡按群系变种（1.21.5），缺省温带', () => {
    expect(variantKeyOf(fakeMob({ type: 'cow' }))).toBe('cow:temperate');
    expect(variantKeyOf(fakeMob({ type: 'cow', variant: 'cold' }))).toBe('cow:cold');
    expect(variantKeyOf(fakeMob({ type: 'pig', variant: 'warm' }))).toBe('pig:warm');
    expect(variantKeyOf(fakeMob({ type: 'chicken', variant: 'cold' }))).toBe('chicken:cold');
    expect(variantKeyOf(fakeMob({ type: 'chicken', variant: 'temperate' }))).toBe('chicken:temperate');
  });
});

describe('群系变种部件表（1.21.5）', () => {
  it('牛/猪寒带热带：同形换料（材质带变种后缀），温带沿用原配色', () => {
    const cold = partsForVariant('cow:cold');
    expect(cold).toHaveLength(8); // 与温带同形
    expect(cold.every((p) => p.mat.endsWith('_cold'))).toBe(true);
    expect(partsForVariant('cow:warm').every((p) => p.mat.endsWith('_warm'))).toBe(true);
    expect(partsForVariant('cow:temperate')).toEqual(partsForVariant('cow')); // 温带即原配色
    expect(partsForVariant('pig:cold')).toHaveLength(7);
    expect(partsForVariant('pig:cold').every((p) => p.mat.endsWith('_cold'))).toBe(true);
    expect(partsForVariant('pig:warm')).toHaveLength(7);
  });

  it('鸡寒带/热带：换料 + 鸡冠部件（温带沿用原 3 部件简模）', () => {
    expect(partsForVariant('chicken')).toHaveLength(3);
    const cold = partsForVariant('chicken:cold');
    expect(cold).toHaveLength(4);
    expect(cold[3]).toMatchObject({ geo: 'horn', mat: 'comb_cold' });
    const warm = partsForVariant('chicken:warm');
    expect(warm).toHaveLength(4);
    expect(warm.filter((p) => p.mat === 'chicken_warm')).toHaveLength(2); // 身 + 头
    expect(warm.some((p) => p.mat === 'beak')).toBe(true); // 喙保持原色
    expect(warm[3]).toMatchObject({ geo: 'horn', mat: 'comb_warm' });
  });

  it('变种分池：寒带牛与热带牛各成一组实例层', () => {
    const pools = new MobInstancePools(fakeMats());
    pools.sync([fakeMob({ type: 'cow', variant: 'cold' }), fakeMob({ type: 'cow', variant: 'warm' })], 0, 0, 0);
    // 牛 4 层（腿合层/身/头/角）× 2 变种 + 共享红闪 1 层
    expect(pools.root.children).toHaveLength(4 + 4 + 1);
    expect(flashMeshOf(pools).count).toBe(2);
    pools.dispose();
  });
});

describe('computeMobRenderState', () => {
  it('敌对朝玩家，被动/逃跑朝移动方向', () => {
    const z = fakeMob({ type: 'zombie', x: 0, z: 0 });
    expect(computeMobRenderState(z, 5, 0, 0).yaw).toBeCloseTo(Math.PI / 2);
    const pig = fakeMob({ type: 'pig', wanderMoving: true, wanderDir: 0 });
    expect(computeMobRenderState(pig, 5, 5, 0).yaw).toBeCloseTo(Math.atan2(1, 0));
    const fleeing = fakeMob({ type: 'zombie', fleeTimer: 1, wanderMoving: true, wanderDir: 0 });
    expect(computeMobRenderState(fleeing, 5, 0, 0).yaw).toBeCloseTo(Math.PI / 2);
  });

  it('缩放：苦力怕引爆膨胀 / 史莱姆体型档 / 幼体 0.55', () => {
    const c = fakeMob({ type: 'creeper', ignite: 3 });
    expect(computeMobRenderState(c, 0, 0, (50 * Math.PI) / 2).scale).toBeCloseTo(1.08);
    expect(computeMobRenderState(fakeMob({ type: 'slime', slimeSize: 2 }), 0, 0, 0).scale).toBeCloseTo(0.7);
    expect(computeMobRenderState(fakeMob({ type: 'slime' }), 0, 0, 0).scale).toBeCloseTo(1.4);
    expect(computeMobRenderState(fakeMob({ baby: true }), 0, 0, 0).scale).toBeCloseTo(0.55);
  });

  it('红闪：hurtImmune > 0.25 或死亡全程', () => {
    expect(computeMobRenderState(fakeMob({ hurtImmune: 0.3 }), 0, 0, 0).flash).toBe(true);
    expect(computeMobRenderState(fakeMob({ hurtImmune: 0.2 }), 0, 0, 0).flash).toBe(false);
    expect(computeMobRenderState(fakeMob({ deathTimer: 0.4 }), 0, 0, 0).flash).toBe(true);
  });

  it('死亡倒地：前 2/3 时间倒完 90°，全程缓沉', () => {
    const start = computeMobRenderState(fakeMob({ deathTimer: MOB_DEATH_DURATION }), 0, 0, 0);
    expect(start.rotZ).toBeCloseTo(0); // -(π/2)*0 = -0
    expect(start.sink).toBeCloseTo(0);
    const end = computeMobRenderState(fakeMob({ deathTimer: 0 }), 0, 0, 0);
    expect(end.rotZ).toBeCloseTo(-Math.PI / 2);
    expect(end.sink).toBeCloseTo(0.3);
  });
});

describe('MobInstancePools', () => {
  it('同种生物共享部件层实例：数量与内容正确', () => {
    const pools = new MobInstancePools(fakeMats());
    const z1 = fakeMob({ x: 10, z: 5 });
    const z2 = fakeMob({ x: 20, z: 5 });
    pools.sync([z1, z2], 10, 5, 0); // 玩家贴脸 → 朝向 yaw = atan2(0,0) = 0

    // 僵尸 4 层（腿×2/臂×2/身/头）+ 共享红闪 1 层 = 5 个 InstancedMesh
    expect(pools.root.children).toHaveLength(5);
    const legs = layersOf(pools, 'leg')[0];
    const heads = layersOf(pools, 'head')[0];
    const arms = layersOf(pools, 'armForward')[0];
    expect(legs.count).toBe(4); // 2 生物 × 2 腿
    expect(arms.count).toBe(4);
    expect(heads.count).toBe(2);
    expect(legs.frustumCulled).toBe(false);

    // z1 左腿：根 T(10,64,5) · 局部(-0.13,0.375,0)
    let e = el(legs, 0);
    expect(e[12]).toBeCloseTo(10 - 0.13);
    expect(e[13]).toBeCloseTo(64.375);
    expect(e[14]).toBeCloseTo(5);
    // z1 右腿
    e = el(legs, 1);
    expect(e[12]).toBeCloseTo(10 + 0.13);
    // z2 头：实例 1（每生物 1 头）
    e = el(heads, 1);
    expect(e[12]).toBeCloseTo(20);
    expect(e[13]).toBeCloseTo(64 + 1.66);
    expect(e[14]).toBeCloseTo(5);
    // 无受击 → 红闪全部零缩放隐藏
    expect(flashMeshOf(pools).count).toBe(2);
    expect(el(flashMeshOf(pools), 0)[0]).toBe(0);
    pools.dispose();
  });

  it('红闪壳：受击个体写真实矩阵（包围盒中心+0.12 圈），未受击写零缩放', () => {
    const pools = new MobInstancePools(fakeMats());
    const z1 = fakeMob({ x: 10, z: 5, hurtImmune: 0.4 });
    const z2 = fakeMob({ x: 20, z: 5 });
    pools.sync([z1, z2], 10, 5, 0);
    const flash = flashMeshOf(pools);
    // 僵尸部件包围盒 x[-0.43,0.43] y[0,1.87] z[-0.21,0.495]（头 z±0.21 / 前平举臂 z 0.22±0.275）
    // → 中心(0,0.935,0.1425)，尺寸(0.86,1.87,0.705)+0.12
    const e = el(flash, 0);
    expect(e[0]).toBeCloseTo(0.98); // x 缩放 = 0.86 + 0.12
    expect(e[5]).toBeCloseTo(1.99); // y 缩放 = 1.87 + 0.12
    expect(e[10]).toBeCloseTo(0.825); // z 缩放 = 0.705 + 0.12
    expect(e[12]).toBeCloseTo(10);
    expect(e[13]).toBeCloseTo(64.935);
    expect(e[14]).toBeCloseTo(5.1425);
    expect(el(flash, 1)[0]).toBe(0); // z2 未受击 → 零缩放
    pools.dispose();
  });

  it('死亡动画：倒地 90° + 缓沉 0.3 体现在实例矩阵', () => {
    const pools = new MobInstancePools(fakeMats());
    const z = fakeMob({ x: 10, z: 5, deathTimer: 0 }); // p=1：倒完
    pools.sync([z], 10, 5, 0);
    const heads = layersOf(pools, 'head')[0];
    const e = el(heads, 0);
    expect(e[0]).toBeCloseTo(0); // cos(-π/2)
    expect(e[1]).toBeCloseTo(-1); // sin(-π/2)
    // 头局部(0,1.66,0) 经 Rz(-90°) → (1.66,0,0)；根平移 y 沉 0.3
    expect(e[12]).toBeCloseTo(10 + 1.66);
    expect(e[13]).toBeCloseTo(64 - 0.3);
    expect(e[14]).toBeCloseTo(5);
    // 死亡全程红闪
    expect(el(flashMeshOf(pools), 0)[0]).toBeGreaterThan(0);
    pools.dispose();
  });

  it('史莱姆缩放作用于根矩阵（同变体池内逐生物不同缩放）', () => {
    const pools = new MobInstancePools(fakeMats());
    const big = fakeMob({ type: 'slime', x: 0, z: 0, slimeSize: 4 });
    const small = fakeMob({ type: 'slime', x: 5, z: 0, slimeSize: 1 });
    pools.sync([big, small], 0, 0, 0);
    const bodies = layersOf(pools, 'slimeBody')[0];
    expect(bodies.count).toBe(2);
    // 小史莱姆朝向玩家（yaw=-π/2），缩放混在旋转列里，用 decompose 提取
    const p = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    bodies.getMatrixAt(0, scratch);
    scratch.decompose(p, q, s);
    expect(s.x).toBeCloseTo(1.4);
    bodies.getMatrixAt(1, scratch);
    scratch.decompose(p, q, s);
    expect(s.x).toBeCloseTo(0.35);
    pools.dispose();
  });

  it('距离门：>48 格只跟位置，位姿冻结在上次近距同步值', () => {
    const pools = new MobInstancePools(fakeMats());
    const z = fakeMob({ x: 100, z: 100 });
    pools.sync([z], 0, 0, 0); // 从未近距 → 默认位姿 yaw 0
    const heads = layersOf(pools, 'head')[0];
    expect(el(heads, 0)[0]).toBeCloseTo(1); // cos(0)
    expect(el(heads, 0)[12]).toBeCloseTo(100);

    z.x = 1;
    z.z = 0;
    pools.sync([z], 0, 0, 0); // 近距：yaw = atan2(0-1, 0-0) = -π/2
    expect(el(heads, 0)[0]).toBeCloseTo(0); // cos(-π/2)

    z.x = 100;
    z.z = 100;
    pools.sync([z], 0, 0, 0); // 再次远距：位姿冻结在 -π/2，位置照跟
    expect(el(heads, 0)[0]).toBeCloseTo(0);
    expect(el(heads, 0)[12]).toBeCloseTo(100);
    pools.dispose();
  });

  it('距离门：远距死亡生物不施加缓沉（y 用原始值，对齐原 position.set 后 continue）', () => {
    const pools = new MobInstancePools(fakeMats());
    const z = fakeMob({ x: 1, z: 0, deathTimer: 0 }); // p=1：倒地+缓沉 0.3
    pools.sync([z], 0, 0, 0); // 近距：sink 施加
    const heads = layersOf(pools, 'head')[0];
    expect(el(heads, 0)[13]).toBeCloseTo(64 - 0.3);

    z.x = 100;
    z.z = 100;
    pools.sync([z], 0, 0, 0); // 远距：倒地角与 yaw 冻结，缓沉不施加（y 为原始 m.y）
    const e = el(heads, 0);
    // 冻结姿态 yaw=-π/2、rotZ=-π/2：头局部 (0,1.66,0) 经 Rz→(1.66,0,0) 再经 Ry(-90°)→(0,0,1.66)
    expect(e[12]).toBeCloseTo(100);
    expect(e[13]).toBeCloseTo(64); // 原始 y，无 -0.3
    expect(e[14]).toBeCloseTo(100 + 1.66);
    pools.dispose();
  });

  it('变体分池：羊剪毛/狼驯服/村民职业各成一组，红闪全变体共享一层', () => {
    const pools = new MobInstancePools(fakeMats());
    const mobs = [
      fakeMob({ type: 'zombie' }),
      fakeMob({ type: 'sheep', woolColor: 'white' }),
      fakeMob({ type: 'sheep', woolColor: 'brown', sheared: true }),
      fakeMob({ type: 'wolf', tamed: true }),
      fakeMob({ type: 'villager' }),
    ];
    pools.sync(mobs, 0, 0, 0);
    // 僵尸 4 层 + 白羊 3 层 + 棕剪毛羊 3 层 + 驯狼 6 层 + 村民 5 层 + 共享红闪 1 层
    expect(pools.root.children).toHaveLength(4 + 3 + 3 + 6 + 5 + 1);
    expect(flashMeshOf(pools).count).toBe(5);
    // 驯狼有项圈层，未驯狼没有
    expect(layersOf(pools, 'collar')).toHaveLength(1);
    expect(layersOf(pools, 'collar')[0].count).toBe(1);
    pools.dispose();
  });

  it('容量倍增：超过初始容量后实例不丢失、计数正确', () => {
    const pools = new MobInstancePools(fakeMats());
    const mobs = Array.from({ length: INITIAL_CAPACITY + 4 }, () => fakeMob());
    pools.sync(mobs, 0, 0, 0);
    const legs = layersOf(pools, 'leg')[0];
    expect(legs.count).toBe((INITIAL_CAPACITY + 4) * 2);
    expect(flashMeshOf(pools).count).toBe(INITIAL_CAPACITY + 4);
    // 倍增后再同步一帧仍正确
    pools.sync(mobs, 0, 0, 0);
    expect(layersOf(pools, 'leg')[0].count).toBe((INITIAL_CAPACITY + 4) * 2);
    pools.dispose();
  });

  it('churn：生物移除后 count 收缩、池对象保留不重建', () => {
    const pools = new MobInstancePools(fakeMats());
    const [z1, z2, z3] = [fakeMob(), fakeMob(), fakeMob()];
    pools.sync([z1, z2, z3], 0, 0, 0);
    const legsBefore = layersOf(pools, 'leg')[0];
    expect(legsBefore.count).toBe(6);
    pools.sync([z1], 0, 0, 0);
    expect(layersOf(pools, 'leg')[0]).toBe(legsBefore); // 同一 InstancedMesh，未重建
    expect(legsBefore.count).toBe(2);
    expect(flashMeshOf(pools).count).toBe(1);
    pools.sync([], 0, 0, 0);
    expect(legsBefore.count).toBe(0);
    expect(flashMeshOf(pools).count).toBe(0);
    pools.dispose();
  });
});
