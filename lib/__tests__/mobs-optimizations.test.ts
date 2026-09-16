// mobs 层第二梯队优化回归：容器注册表、铁傀儡空间分桶、恋爱动物分桶、colTop 缓存
import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, LEAVES, STONE } from '../blocks';
import { worldClock } from '../game';
import { clearDrops } from '../items';
import { clearMobs, damageMob, feedMob, MOB_DEFS, mobs, spawnMobAt, tickMobs } from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { clearStorages, getStorage, storages } from '../storage';
import { weather } from '../weather';
import { World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;

/** 石板地面（y=40）的虚空测试世界 */
function floorWorld(name: string, size = 8): World {
  const w = new World(name, undefined, VOID_TERRAIN);
  for (let x = -size; x < size; x++) for (let z = -size; z < size; z++) w.setBlock(x, 40, z, STONE);
  return w;
}

const FAR_PLAYER = { x: 500, y: 41, z: 500 };

function step(w: World, seconds: number): void {
  const n = Math.round(seconds / 0.1);
  for (let i = 0; i < n; i++) tickMobs(w, 0.1, FAR_PLAYER, () => undefined, null, true);
}

function mkMob(type: 'cow' | 'pig' | 'sheep' | 'zombie' | 'iron_golem', x: number, z: number, extra?: Partial<(typeof mobs)[number]>) {
  return {
    id: Math.random(), type, x, y: 41, z,
    velY: 0, hp: MOB_DEFS[type].hp, attackCd: 0, onGround: true,
    wanderDir: 0, wanderTimer: 0, wanderMoving: false,
    fleeTimer: 0, fleeFromX: 0, fleeFromZ: 0, arrowCd: 1, ignite: -1,
    ...extra,
  };
}

beforeEach(() => {
  clearMobs();
  clearDrops();
  clearStorages();
  worldClock.t = 0.3;
  weather.kind = 'clear';
});

describe('容器注册表（world.containerRegistry）', () => {
  it('setBlock 放置箱子/铜箱/木桶会登记，破坏会移除', () => {
    const w = floorWorld('registry');
    expect(w.containerRegistry.size).toBe(0);
    w.setBlock(1, 41, 2, K('chest'));
    w.setBlock(2, 41, 2, K('copper_chest'));
    w.setBlock(3, 41, 2, K('barrel'));
    expect(w.containerRegistry.size).toBe(1);
    const byId = w.containerRegistry.get('0,0');
    expect(byId?.get(K('chest'))?.has('1,41,2')).toBe(true);
    expect(byId?.get(K('copper_chest'))?.has('2,41,2')).toBe(true);
    expect(byId?.get(K('barrel'))?.has('3,41,2')).toBe(true);
    w.setBlock(2, 41, 2, AIR);
    expect(byId?.has(K('copper_chest'))).toBe(false);
  });

  it('铜傀儡搬运仍按最近同类箱优先、空位兜底', () => {
    const w = floorWorld('golem-registry');
    w.setBlock(0, 41, 4, K('copper_chest'));
    getStorage('0,41,4')[0] = { kind: 'block', id: STONE, count: 20 };
    w.setBlock(2, 41, 4, K('chest'));
    getStorage('2,41,4')[0] = { kind: 'block', id: STONE, count: 1 };
    w.setBlock(1, 41, 3, K('chest')); // 更近但空箱
    spawnMobAt('copper_golem', 1.2, 41, 4.5);
    step(w, 2);
    expect((storages.get('2,41,4') ?? []).reduce((n, s) => n + (s?.kind === 'block' && s.id === STONE ? s.count : 0), 0)).toBe(17);
    expect((storages.get('1,41,3') ?? []).reduce((n, s) => n + (s?.kind === 'block' && s.id === STONE ? s.count : 0), 0)).toBe(0);
  });

  it('chunk 卸载后注册表清理，避免扫描已卸载容器', () => {
    const w = floorWorld('unload-registry', 8);
    w.setBlock(50, 50, 50, K('chest')); // chunk 3,3
    expect(w.containerRegistry.has('3,3')).toBe(true);
    w.updateAround(0, 0, 0); // 视距 0：只保留 ±2 chunk，3,3 被卸载
    expect(w.containerRegistry.has('3,3')).toBe(false);
  });
});

describe('铁傀儡目标选择空间分桶', () => {
  it('仍只猎杀 24 格内敌对怪，不攻击被动生物', () => {
    const w = floorWorld('golem-spatial');
    worldClock.t = 0.75; // 夜晚：避免僵尸自燃干扰
    mobs.push(mkMob('iron_golem', 0.5, 0.5));
    mobs.push(mkMob('zombie', 1.5, 0.5)); // 1 格距离，确保能命中
    mobs.push(mkMob('pig', 0.5, 2.5));
    for (let i = 0; i < 80 && mobs.some((m) => m.type === 'zombie'); i++) {
      tickMobs(w, 0.1, { x: 8.5, y: 41, z: 8.5 }, () => undefined);
    }
    expect(mobs.some((m) => m.type === 'zombie')).toBe(false);
    expect(mobs.filter((m) => m.type === 'pig').length).toBe(1);
    expect(mobs.find((m) => m.type === 'pig')?.hp).toBe(10);
  });

  it('25 格外的敌对怪不被锁定', () => {
    const w = floorWorld('golem-range');
    worldClock.t = 0.75; // 夜晚
    const g = mkMob('iron_golem', 0.5, 0.5);
    const z = mkMob('zombie', 26.5, 0.5); // 26 格 > 24
    mobs.push(g, z);
    for (let i = 0; i < 20; i++) tickMobs(w, 0.1, { x: 500, y: 41, z: 500 }, () => undefined);
    expect(z.hp).toBe(20);
  });
});

describe('恋爱动物分桶', () => {
  it('feedMob 后同种恋爱个体靠近产仔', () => {
    const w = floorWorld('love-bucket');
    const a = mkMob('cow', 0.5, 0.5);
    const b = mkMob('cow', 1.5, 0.5);
    mobs.push(a, b);
    feedMob(a);
    feedMob(b);
    for (let i = 0; i < 30 && mobs.length < 3; i++) tickMobs(w, 0.1, FAR_PLAYER, () => undefined);
    expect(mobs.some((m) => m.baby)).toBe(true);
    expect(a.loveTimer).toBe(0);
    expect(b.loveTimer).toBe(0);
    expect((a.breedCd ?? 0)).toBeGreaterThan(0);
    expect((b.breedCd ?? 0)).toBeGreaterThan(0);
  });

  it('不同种恋爱个体不配对', () => {
    const w = floorWorld('love-species');
    const a = mkMob('cow', 0.5, 0.5);
    const b = mkMob('pig', 1.5, 0.5);
    mobs.push(a, b);
    feedMob(a);
    feedMob(b);
    for (let i = 0; i < 30; i++) tickMobs(w, 0.1, FAR_PLAYER, () => undefined);
    expect(mobs).toHaveLength(2);
  });

  it('死亡时从恋爱桶移除，不影响清除后再配对', () => {
    const w = floorWorld('love-death');
    const a = mkMob('cow', 0.5, 0.5);
    const b = mkMob('cow', 1.5, 0.5);
    mobs.push(a, b);
    feedMob(a);
    feedMob(b);
    damageMob(a, 999, { x: 0, z: 0 }, 0, w);
    tickMobs(w, 0.1, FAR_PLAYER, () => undefined); // 让死亡态 a 从恋爱桶清出
    const c = mkMob('cow', 2.5, 0.5);
    mobs.push(c);
    feedMob(c);
    for (let i = 0; i < 30 && mobs.length < 4; i++) tickMobs(w, 0.1, FAR_PLAYER, () => undefined);
    expect(mobs.some((m) => m.baby)).toBe(true);
  });
});

describe('colTop 列顶缓存', () => {
  it('放置/破坏不透明方块会增量更新 colTop', () => {
    const w = floorWorld('coltop');
    expect(w.getColTop(0, 0)).toBe(40);
    w.setBlock(0, 50, 0, STONE);
    expect(w.getColTop(0, 0)).toBe(50);
    w.setBlock(0, 50, 0, AIR);
    expect(w.getColTop(0, 0)).toBe(40);
  });

  it('树叶/水/玻璃不进入 colTop', () => {
    const w = floorWorld('coltop-transparent');
    w.setBlock(0, 50, 0, LEAVES);
    expect(w.getColTop(0, 0)).toBe(40);
    w.setBlock(0, 50, 0, AIR);
    expect(w.getColTop(0, 0)).toBe(40);
  });

  it('破坏列顶下方方块不改变 colTop', () => {
    const w = floorWorld('coltop-below');
    w.setBlock(0, 45, 0, STONE);
    expect(w.getColTop(0, 0)).toBe(45);
    w.setBlock(0, 42, 0, AIR);
    expect(w.getColTop(0, 0)).toBe(45);
  });

  it('exposedToSky 用 colTop O(1) 判定露天', () => {
    const w = floorWorld('coltop-sky');
    worldClock.t = 0.25;
    const z = spawnMobAt('zombie', 0.5, 41, 0.5);
    for (let i = 0; i < 5; i++) tickMobs(w, 0.2, { x: 500, y: 41, z: 500 }, () => undefined);
    expect(z.hp).toBeLessThan(20);
    // 加盖不透明顶棚
    w.setBlock(0, 50, 0, STONE);
    const z2 = spawnMobAt('zombie', 0.5, 41, 0.5);
    for (let i = 0; i < 5; i++) tickMobs(w, 0.2, { x: 500, y: 41, z: 500 }, () => undefined);
    expect(z2.hp).toBe(20);
  });
});
