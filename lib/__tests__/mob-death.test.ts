// 生物受击与死亡反馈（MC 死亡演出）：死亡态计时与延迟移除、掉落/经验仍在死亡开始结算、
// 结束白烟事件、尸体不 AI 不攻击也不可再被攻击、烧死/摔死统一走死亡态、clearMobs 不残留

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STONE } from '../blocks';
import { breakParticles, worldClock } from '../game';
import { clearDrops, itemDrops } from '../items';
import {
  clearMobs,
  damageMob,
  DEATH_SMOKE_TILE,
  makeSlime,
  MOB_DEATH_DURATION,
  MOB_DEFS,
  mobInReach,
  mobs,
  phantomState,
  tickMobs,
  type Mob,
  type MobType,
} from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { emptySlots } from '../slots';
import { useGameStore } from '../store';
import { weather } from '../weather';
import { World } from '../world';

/** 构造测试生物（hp 默认取物种定义值） */
function mkMob(partial: Partial<Mob> & { type: MobType; x: number; y: number; z: number }): Mob {
  return {
    id: Math.random(),
    velY: 0,
    hp: MOB_DEFS[partial.type].hp,
    attackCd: 0,
    onGround: true,
    wanderDir: 0,
    wanderTimer: 0,
    wanderMoving: false,
    fleeTimer: 0,
    fleeFromX: 0,
    fleeFromZ: 0,
    arrowCd: 1,
    ignite: -1,
    ...partial,
  };
}

/** 石板地面（y=40）虚空世界：白天 + 非草地 = 刷怪/自燃不干扰 */
function floorWorld(): World {
  const w = new World('mob-death', undefined, VOID_TERRAIN);
  for (let x = -16; x < 16; x++) for (let z = -16; z < 16; z++) w.setBlock(x, 40, z, STONE);
  return w;
}

const player = { x: 8.5, y: 41, z: 8.5 };

beforeEach(() => {
  clearMobs();
  clearDrops();
  breakParticles.length = 0;
  phantomState.insomniaDays = 0;
  phantomState.timer = 0;
  worldClock.t = 0.3;
  weather.kind = 'clear';
  useGameStore.setState({ worldMode: 'survival', xpTotal: 0, hotbarSlots: emptySlots(), selectedSlot: 0 });
});

describe('死亡态', () => {
  it('致死伤害进入死亡态：尸体保留；掉落与经验仍在死亡开始即结算（MC）', () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.99); // 腐肉数量取满
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 8.5, hp: 4 });
    mobs.push(z);
    const xp0 = useGameStore.getState().xpTotal;
    expect(damageMob(z, 4, { x: 0, z: 0 })).toBe(true);
    rnd.mockRestore();
    expect(mobs.includes(z)).toBe(true); // 尸体保留（不再立即移除）
    expect(z.hp).toBeLessThanOrEqual(0);
    expect(z.deathTimer).toBe(MOB_DEATH_DURATION);
    // 掉落与经验不等地动画结束：死亡开始已结算（与现状一致）
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'rotten_flesh')).toBe(true);
    expect(useGameStore.getState().xpTotal).toBe(xp0 + 5);
  });

  it('死亡态期间不 AI/不移动/不攻击玩家', () => {
    const w = floorWorld();
    const z = mkMob({ type: 'zombie', x: 9.2, y: 41, z: 8.5, hp: 1 }); // 贴身
    mobs.push(z);
    damageMob(z, 5, { x: 0, z: 0 });
    const { x, y, z: zz } = z;
    let dmg = 0;
    for (let i = 0; i < 5; i++) tickMobs(w, 0.1, player, (d) => (dmg += d));
    expect(dmg).toBe(0); // 尸体不攻击
    expect(z.x).toBe(x);
    expect(z.y).toBe(y);
    expect(z.z).toBe(zz); // 尸体纹丝不动
    expect(mobs.includes(z)).toBe(true); // 0.5s < 0.8s：动画未结束不移除
  });

  it('动画计时结束才真正移除，并推一条白烟粒子事件（位置为死亡点）', () => {
    const w = floorWorld();
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 8.5, hp: 1 });
    mobs.push(z);
    damageMob(z, 5);
    for (let i = 0; i < 7; i++) tickMobs(w, 0.1, player, () => undefined); // 0.7s < 0.8s
    expect(mobs.includes(z)).toBe(true);
    for (let i = 0; i < 5 && mobs.includes(z); i++) tickMobs(w, 0.1, player, () => undefined);
    expect(mobs.includes(z)).toBe(false); // 归零才移除
    const smoke = breakParticles.filter((e) => e.tile === DEATH_SMOKE_TILE);
    expect(smoke).toHaveLength(1); // 只推一次
    expect(smoke[0].x).toBeCloseTo(8.5);
    expect(smoke[0].y).toBeCloseTo(41);
    expect(smoke[0].z).toBeCloseTo(8.5);
  });

  it('死亡态不二次结算：尸体不再吃伤害，掉落/经验不重复发', () => {
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 8.5, hp: 1 });
    mobs.push(z);
    expect(damageMob(z, 5, { x: 0, z: 0 })).toBe(true);
    const drops0 = itemDrops.length;
    const xp0 = useGameStore.getState().xpTotal;
    expect(damageMob(z, 5, { x: 0, z: 0 })).toBe(false); // 同一尸体二次命中（横扫/铁傀儡当帧补刀）
    expect(z.hp).toBe(-4); // 未被二次扣减
    expect(itemDrops.length).toBe(drops0);
    expect(useGameStore.getState().xpTotal).toBe(xp0);
  });

  it('mobInReach 打不到死亡态尸体（MC：尸体不可被攻击）', () => {
    const w = floorWorld();
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 10.5, hp: 1 });
    mobs.push(z);
    expect(mobInReach(w, 8.5, 42, 8.5, 0, 0, 1, 6)?.id).toBe(z.id); // 活着能命中
    damageMob(z, 5);
    expect(mobInReach(w, 8.5, 42, 8.5, 0, 0, 1, 6)).toBeNull(); // 尸体打不到
  });

  it('烧死/摔死统一走死亡态（与伤害致死同一入口）', () => {
    const w = floorWorld();
    worldClock.t = 0.25; // 正午
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 8.5, hp: 1 });
    mobs.push(z);
    tickMobs(w, 1, player, () => undefined); // 烧死
    expect(z.hp).toBeLessThanOrEqual(0);
    expect(z.deathTimer).toBeGreaterThan(0);
    expect(mobs.includes(z)).toBe(true);
    const z2 = mkMob({ type: 'zombie', x: 4.5, y: 41.05, z: 8.5, onGround: false, velY: -1, fallDist: 30, hp: 5 });
    mobs.push(z2);
    tickMobs(w, 0.05, player, () => undefined); // 摔死
    expect(z2.hp).toBeLessThanOrEqual(0);
    expect(z2.deathTimer).toBeGreaterThan(0);
    expect(mobs.includes(z2)).toBe(true);
  });

  it('史莱姆大档击杀：分裂不留尸体（立即移除）但同样出白烟', () => {
    const w = floorWorld();
    const big = makeSlime(8.5, 41, 8.5, 4);
    mobs.push(big);
    damageMob(big, 999, undefined, 0, w);
    expect(mobs.includes(big)).toBe(false); // 分裂替代倒地（MC）
    expect(mobs.filter((m) => m.type === 'slime' && m.slimeSize === 2).length).toBeGreaterThanOrEqual(2);
    expect(breakParticles.some((e) => e.tile === DEATH_SMOKE_TILE)).toBe(true);
  });

  it('clearMobs 清空死亡态：不残留尸体/计时器', () => {
    const z = mkMob({ type: 'zombie', x: 8.5, y: 41, z: 8.5, hp: 1 });
    mobs.push(z);
    damageMob(z, 5);
    clearMobs();
    expect(mobs).toHaveLength(0);
    const w = floorWorld();
    expect(() => tickMobs(w, 0.1, player, () => undefined)).not.toThrow();
    expect(mobs).toHaveLength(0); // 不复活
  });
});
