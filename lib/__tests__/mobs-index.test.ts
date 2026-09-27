// mobs 常驻 chunk 索引 / 刷怪计数器 / Boss 缓存回归：
// mobInReach·箭命中·群体仇恨·村庄守卫扫描改桶扫描后语义等价；外部直改 mobs 数组（绕过内部维护）由总数校验重建兜住
import { beforeEach, describe, expect, it } from 'vitest';
import { isSneaking } from '../actions';
import { STONE } from '../blocks';
import { bossState, touchInput, worldClock } from '../game';
import {
  clearMobs,
  damageMob,
  firePlayerArrow,
  makeWither,
  MOB_DEFS,
  mobInReach,
  mobs,
  onMobTamed,
  spawnMobAt,
  tickMobs,
  type Mob,
  type MobType,
} from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { useGameStore } from '../store';
import { World } from '../world';

/** 石板地面（y=40）的虚空测试世界（16×16：覆盖本文件所有用例的活动范围，且构建快） */
function floorWorld(name: string, size = 16): World {
  const w = new World(name, undefined, VOID_TERRAIN);
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) w.setBlock(x, 40, z, STONE);
  return w;
}

/** 造一只完整的 mob 对象（与 mobs-optimizations.test.ts 的 mkMob 同款，外部直推用——绕过 spawnMobAt 的内部维护） */
function mkMob(type: MobType, x: number, z: number, extra?: Partial<Mob>): Mob {
  return {
    id: Math.random(), type, x, y: 41, z,
    velY: 0, hp: MOB_DEFS[type].hp, attackCd: 0, onGround: true,
    wanderDir: 0, wanderTimer: 0, wanderMoving: false,
    fleeTimer: 0, fleeFromX: 0, fleeFromZ: 0, arrowCd: 1, ignite: -1,
    ...extra,
  } as Mob;
}

const NEAR_PLAYER = { x: 8.5, y: 41, z: 8.5 };

beforeEach(() => {
  clearMobs();
  worldClock.t = 0.3; // 白天：无自燃/无夜晚刷怪干扰
  touchInput.sneak = false;
  useGameStore.setState({ worldMode: 'survival', xpTotal: 0 });
});

describe('mobInReach 常驻索引扫描', () => {
  it('正常命中近处生物（与旧全扫一致）', () => {
    const w = floorWorld('reach-basic');
    const z = spawnMobAt('zombie', 4.5, 41, 4.5);
    const hit = mobInReach(w, 4.5, 41.9, 8.5, 0, 0, -1, 6);
    expect(hit).toBe(z);
  });

  it('reach 24（末影人对视）可命中跨 2 个 chunk 的生物', () => {
    const w = floorWorld('reach-far');
    const e = spawnMobAt('enderman', 30.5, 41, 8.5); // chunk (1,0)，距原点 22 格
    const hit = mobInReach(w, 8.5, 41.9, 8.5, 1, 0, 0, 24);
    expect(hit).toBe(e);
  });

  it('外部直推 mobs（绕过索引维护）后仍能命中——总数校验重建', () => {
    const w = floorWorld('reach-extern');
    mobs.push(mkMob('zombie', 8.5, 4.5)); // chunk (0,0)，直接 push 未入索引
    const hit = mobInReach(w, 8.5, 41.9, 8.5, 0, 0, -1, 6);
    expect(hit?.type).toBe('zombie');
  });

  it('死亡态尸体不可命中', () => {
    const w = floorWorld('reach-corpse');
    const z = spawnMobAt('zombie', 8.5, 41, 6.5);
    damageMob(z, 999, undefined, 0, w);
    expect(z.hp).toBeLessThanOrEqual(0);
    const hit = mobInReach(w, 8.5, 41.9, 8.5, 0, 0, -1, 6);
    expect(hit).toBeNull();
  });
});

describe('箭命中（tickArrows 桶扫描）', () => {
  it('玩家箭命中外部直推的生物', () => {
    const w = floorWorld('arrow-extern');
    const pig = mkMob('pig', 8.5, 12.5); // 起点前方 4 格（同 chunk 行）
    mobs.push(pig);
    firePlayerArrow({ x: 8.5, y: 41.5, z: 8.5 }, { x: 0, y: 0, z: 1 });
    for (let i = 0; i < 20 && pig.hp > 0; i++) tickMobs(w, 0.02, NEAR_PLAYER, () => undefined);
    expect(pig.hp).toBeLessThan(MOB_DEFS.pig.hp);
  });

  it('末影人中箭瞬移闪避不掉血（瞬移跨 chunk 立即归位）', () => {
    const w = floorWorld('arrow-enderman');
    const e = mkMob('enderman', 8.5, 12.5);
    mobs.push(e);
    firePlayerArrow({ x: 8.5, y: 41.5, z: 8.5 }, { x: 0, y: 0, z: 1 });
    const before = { x: e.x, z: e.z };
    for (let i = 0; i < 20; i++) tickMobs(w, 0.02, NEAR_PLAYER, () => undefined);
    expect(e.x !== before.x || e.z !== before.z).toBe(true); // 箭命中前瞬移
    expect(e.hp).toBe(MOB_DEFS.enderman.hp);
  });
});

describe('刷怪计数器（hostile 上限与驯服口径）', () => {
  it('敌对满 8 只后夜晚不再刷敌对', () => {
    const w = floorWorld('cap-hostile');
    worldClock.t = 0.75; // 午夜
    for (let i = 0; i < 8; i++) mobs.push(mkMob('zombie', 11.5 + i * 0.5, 11.5)); // 直推 8 敌对（玩家近旁不 despawn）
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined); // 对账重建计数 + 首次刷怪判定（满员应被挡住）
    expect(mobs).toHaveLength(8);
    for (let i = 0; i < 15; i++) {
      tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
      expect(mobs.filter((m) => MOB_DEFS[m.type].hostile && !m.tamed && m.type !== 'iron_golem')).toHaveLength(8);
    }
  });

  it('onMobTamed 把驯服狼移出敌对计数', () => {
    const w = floorWorld('cap-tamed');
    worldClock.t = 0.75;
    for (let i = 0; i < 7; i++) mobs.push(mkMob('zombie', 11.5 + i * 0.5, 11.5));
    const wolf = mkMob('wolf', 14.5, 14.5);
    mobs.push(wolf); // 8 敌对（狼 def 为 hostile）
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    for (let i = 0; i < 6; i++) tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(mobs).toHaveLength(8); // 满员不刷
    wolf.tamed = true;
    onMobTamed(wolf); // actions.ts 驯狼路径的计数钩子
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(mobs.filter((m) => MOB_DEFS[m.type].hostile && !m.tamed && m.type !== 'iron_golem')).toHaveLength(7);
  });
});

describe('Boss 血条缓存', () => {
  it('外部直推凋灵：48 格内显示血条，离开/死亡后清空', () => {
    const w = floorWorld('boss-wither');
    const boss = makeWither(12.5, 41, 12.5); // 外部构造（wither.ts 召唤同款直推路径）
    mobs.push(boss);
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(bossState.name).toBe('凋灵');
    expect(bossState.hp).toBe(MOB_DEFS.wither.hp);
    // 拉远到 48 格外（凋灵悬浮无重力，直接改坐标模拟离场）
    boss.x = 100.5;
    boss.z = 100.5;
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(bossState.name).toBe('');
    // 拉回并击杀：尸体窗口内血条仍在（hp=0），尸体移除后清空
    boss.x = 12.5;
    boss.z = 12.5;
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(bossState.name).toBe('凋灵');
    damageMob(boss, 9999, undefined, 0, w);
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(bossState.name).toBe('凋灵'); // 尸体（0.8s 演出）仍命中——与原 mobs.find 无 hp 门槛一致
    expect(bossState.hp).toBe(0);
    for (let i = 0; i < 20 && mobs.length > 0; i++) tickMobs(w, 0.1, NEAR_PLAYER, () => undefined);
    expect(mobs).toHaveLength(0);
    tickMobs(w, 0.05, NEAR_PLAYER, () => undefined);
    expect(bossState.name).toBe('');
  });
});

describe('群体仇恨（damageMob 桶扫描）', () => {
  it('32 格内猪灵传染、32 格外不传染（贴 chunk 边界的同伴也在邻桶被扫到）', () => {
    const w = floorWorld('aggro-piglin');
    const hurt = mkMob('piglin', 15.5, 8.5); // chunk (0,0) 贴边
    const near = mkMob('piglin', 47.5, 8.5); // chunk (2,0)，距受击者 32 格——跨桶覆盖边界情形
    const far = mkMob('piglin', 15.5, 60.5); // 51.5 格外
    mobs.push(hurt, near, far);
    damageMob(hurt, 1, { x: 0, z: 0 }, 0, w);
    expect(hurt.aggroTimer).toBeGreaterThan(0); // 自身激怒（原全扫含自身，桶扫描同样覆盖）
    expect(near.aggroTimer).toBe(40);
    expect(far.aggroTimer ?? 0).toBe(0);
  });

  it('玩家攻击村民：32 格内铁傀儡护村仇恨', () => {
    const w = floorWorld('aggro-villager');
    const v = mkMob('villager', 8.5, 8.5);
    const g = mkMob('iron_golem', 40.5, 8.5); // 32 格整（边界内含）
    const g2 = mkMob('iron_golem', 41.5, 8.5); // 33 格外
    mobs.push(v, g, g2);
    damageMob(v, 1, { x: 8.5, z: 8.5 }, 0, w);
    expect(g.aggroTimer).toBe(40);
    expect(g2.aggroTimer ?? 0).toBe(0);
  });
});

describe('isSneaking（无 window 环境退化为触屏开关）', () => {
  it('node 测试环境无 window：仅 touchInput.sneak 生效', () => {
    expect(typeof window).toBe('undefined');
    expect(isSneaking()).toBe(false);
    touchInput.sneak = true;
    expect(isSneaking()).toBe(true);
    touchInput.sneak = false;
  });
});
