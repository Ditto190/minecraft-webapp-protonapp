// 1.21.9 Copper Age：铜箱（注册/配方/存取/比较器满度/炸毁掉落）与铜傀儡（建造判定/搬运分拣/冷却/掉落）。
// Java 差异（见各注释）：铜箱只做普通态（无 4 氧化级 + 涂蜡）；铜傀儡用普通南瓜建造（Java 需雕刻南瓜/南瓜灯）、
// 不氧化；搬运目标取最近（Java 依次拜访最多 10 个）、空铜箱驻留 3s（Java 7s）。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIR, BLOCK_BY_KEY, ICON_TILE_START, STONE } from '../blocks';
import { explodeAt } from '../explosion';
import { worldClock } from '../game';
import { clearDrops, itemDrops } from '../items';
import { clearMobs, damageMob, MOB_DEFS, mobs, spawnMobAt, tickMobs, tryBuildCopperGolem } from '../mobs';
import { VOID_TERRAIN, type Terrain } from '../noise';
import { clearRedstone, dustPowerAt, tickRedstone } from '../redstone';
import { applyCraft, canCraft, RECIPES, recipePattern } from '../recipes';
import { addStackToSlots, emptySlots } from '../slots';
import { clearStorages, getStorage, isStorageBlockId, mergeIntoStorage, putIntoStorage, storages, takeFromStorage } from '../storage';
import { weather } from '../weather';
import { World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;
const DUST = () => K('redstone_dust');
const FAR_PLAYER = { x: 500, y: 41, z: 500 };
const TNT_OPTS = { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true };

/** 海洋群系虚空（排除村庄/结构对刷怪的干扰；参照 mobs-ecology 测试惯例） */
const OCEAN_VOID: Terrain = { ...VOID_TERRAIN, biomeAt: () => 'ocean' };

/** 石板地面（y=40）的虚空测试世界：被动刷怪需草地（石板刷不出），不干扰搬运断言。
 *  仅铺中央小块（setBlock 带光照重算，铺大了测试慢）；容器/傀儡都在原点附近 */
function floorWorld(name: string, size = 8): World {
  const w = new World(name, undefined, OCEAN_VOID);
  for (let x = -size; x < size; x++) for (let z = -size; z < size; z++) w.setBlock(x, 40, z, STONE);
  return w;
}

/** 以 0.1s 步长推进生物 AI（玩家放远处：铜傀儡为被动生物不消失、不追击） */
function step(w: World, seconds: number): void {
  const n = Math.round(seconds / 0.1);
  for (let i = 0; i < n; i++) tickMobs(w, 0.1, FAR_PLAYER, () => undefined, null, true);
}

/** 槽内某方块的总数 */
function blockCount(key: string, id: number): number {
  return (storages.get(key) ?? []).reduce((n, s) => n + (s?.kind === 'block' && s.id === id ? s.count : 0), 0);
}

beforeEach(() => {
  clearMobs();
  clearDrops();
  clearStorages();
  clearRedstone();
  worldClock.t = 0.3; // 白天：不刷敌对
  weather.kind = 'clear';
});

describe('铜箱注册（1.21.9；Java：硬度 3、石镐及以上才掉本体，否则只掉内容物）', () => {
  it('追加在注册表末尾（存档兼容）：pickaxe/pickTier 1/digTime 15/utility', () => {
    const d = BLOCK_BY_KEY.copper_chest;
    expect(d).toBeDefined();
    expect(d.id).toBeGreaterThan(BLOCK_BY_KEY.grindstone.id);
    expect(d.tool).toBe('pickaxe');
    expect(d.needsPick).toBe(true);
    expect(d.pickTier).toBe(1);
    expect(d.digTime).toBe(15);
    expect(d.cat).toBe('utility');
    // 顶/底复用铜块贴图，侧面 canvas 图标格
    expect(d.top).toBe(BLOCK_BY_KEY.copper_block.top);
    expect(d.bottom).toBe(BLOCK_BY_KEY.copper_block.top);
    expect(d.side).toBe(ICON_TILE_START + 33);
  });

  it('配方：箱子×1 + 铜锭×8（工作台），摆法箱居中铜围一圈（Java）', () => {
    const r = RECIPES.find((x) => x.id === 'copper_chest');
    expect(r).toBeDefined();
    expect(r!.out).toEqual({ kind: 'block', id: K('copper_chest'), count: 1 });
    expect(r!.needsTable).toBe(true);
    expect(r!.cost).toEqual([
      { item: `block:${K('chest')}`, count: 1 },
      { item: 'material:copper_ingot', count: 8 },
    ]);
    expect(recipePattern(r!)).toEqual([
      'material:copper_ingot', 'material:copper_ingot', 'material:copper_ingot',
      'material:copper_ingot', `block:${K('chest')}`, 'material:copper_ingot',
      'material:copper_ingot', 'material:copper_ingot', 'material:copper_ingot',
    ]);
    let slots = emptySlots();
    slots = addStackToSlots(slots, { kind: 'block', id: K('chest') }, 1).slots;
    slots = addStackToSlots(slots, { kind: 'material', material: 'copper_ingot' }, 8).slots;
    expect(canCraft(slots, r!)).toBe(true);
    slots = applyCraft(slots, r!, 0);
    expect(slots.some((s) => s?.kind === 'block' && s.id === K('copper_chest'))).toBe(true);
    expect(canCraft(slots, r!)).toBe(false); // 材料已耗尽
  });
});

describe('铜箱容器接入（与箱子/木桶同一 storage 路径）', () => {
  it('isStorageBlockId 覆盖箱子/木桶/铜箱，排除熔炉等', () => {
    expect(isStorageBlockId(K('chest'))).toBe(true);
    expect(isStorageBlockId(K('barrel'))).toBe(true);
    expect(isStorageBlockId(K('copper_chest'))).toBe(true);
    expect(isStorageBlockId(K('furnace'))).toBe(false);
    expect(isStorageBlockId(STONE)).toBe(false);
  });

  it('存取整叠并并堆（27 槽同木箱）', () => {
    const storage = getStorage('5,41,5');
    storage[0] = { kind: 'block', id: STONE, count: 30 };
    let slots = emptySlots();
    slots[0] = { kind: 'block', id: STONE, count: 40 };
    slots = putIntoStorage(slots, 0, storage);
    expect(storage[0]).toEqual({ kind: 'block', id: STONE, count: 64 });
    expect(storage[1]).toEqual({ kind: 'block', id: STONE, count: 6 });
    expect(slots[0]).toBeNull();
    slots = takeFromStorage(slots, storage, 0);
    expect(slots[0]).toEqual({ kind: 'block', id: STONE, count: 64 });
    expect(storage[0]).toBeNull();
  });

  it('mergeIntoStorage：先并同类未满堆再占空格；容器满返回剩余（铜傀儡放货用）', () => {
    const st = getStorage('m');
    st[0] = { kind: 'block', id: STONE, count: 60 };
    expect(mergeIntoStorage(st, { kind: 'block', id: STONE, count: 10 })).toBe(0);
    expect(st[0]).toEqual({ kind: 'block', id: STONE, count: 64 });
    expect(st[1]).toEqual({ kind: 'block', id: STONE, count: 6 });
    // 填满后原数退回
    for (let i = 0; i < st.length; i++) st[i] = { kind: 'block', id: BLOCK_BY_KEY.dirt.id, count: 64 };
    expect(mergeIntoStorage(st, { kind: 'block', id: STONE, count: 16 })).toBe(16);
  });

  it('铜箱被炸：内容物掉落并清状态（炸毁路径分派）', () => {
    const w = new World('copper-boom', undefined, OCEAN_VOID);
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
    w.setBlock(4, 30, 4, K('copper_chest'));
    const s = getStorage('4,30,4');
    s[0] = { kind: 'block', id: STONE, count: 5 };
    s[1] = { kind: 'material', material: 'coal', count: 3 };
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0); // 钉死随机数：必碎必掉
    try {
      explodeAt(w, 4.5, 30.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 30, 4)).toBe(AIR);
    expect(storages.has('4,30,4')).toBe(false);
    expect(itemDrops.some((d) => d.drop.kind === 'block' && d.drop.blockId === STONE && d.count === 5)).toBe(true);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'coal' && d.count === 3)).toBe(true);
  });
});

describe('铜箱比较器满度（同箱子 27 槽公式：1 + floor(Σ占比/27×14)）', () => {
  function copperComparator(w: World): void {
    w.setBlock(0, 30, 4, K('copper_chest'));
    w.setBlock(1, 30, 4, K('comparator_e')); // 背向 = (0,30,4) 铜箱
    w.setBlock(2, 30, 4, DUST());
    w.setBlock(3, 30, 4, DUST());
  }

  it('满铜箱（27×64）输出 15', () => {
    const w = new World('copper-comp', undefined, OCEAN_VOID);
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
    const s = getStorage('0,30,4');
    for (let i = 0; i < s.length; i++) s[i] = { kind: 'block', id: STONE, count: 64 };
    copperComparator(w);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(1, 30, 4)).toBe(K('comparator_on_e'));
    expect(dustPowerAt(2, 30, 4)).toBe(15);
    expect(dustPowerAt(3, 30, 4)).toBe(14);
  });

  it('空铜箱输出 0', () => {
    const w = new World('copper-comp-empty', undefined, OCEAN_VOID);
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
    copperComparator(w); // 无内容
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(1, 30, 4)).toBe(K('comparator_e'));
    expect(dustPowerAt(2, 30, 4)).toBe(0);
  });
});

describe('铜傀儡建造（南瓜 + 铜块贴邻；Java 需雕刻南瓜/南瓜灯，项目无雕刻南瓜从简用普通南瓜）', () => {
  it('南瓜放铜块顶：铜块原位变铜箱、南瓜消失、生成铜傀儡（Java 规则）', () => {
    const w = floorWorld('build-top');
    w.setBlock(0, 41, 0, K('copper_block'));
    w.setBlock(0, 42, 0, K('pumpkin'));
    expect(tryBuildCopperGolem(w, 0, 42, 0)).toBe(true);
    expect(w.getBlock(0, 41, 0)).toBe(K('copper_chest'));
    expect(w.getBlock(0, 42, 0)).toBe(AIR);
    const g = mobs.find((m) => m.type === 'copper_golem');
    expect(g).toBeDefined();
    expect(g!.x).toBeCloseTo(0.5);
    expect(g!.y).toBe(42);
    expect(g!.hp).toBe(MOB_DEFS.copper_golem.hp); // 12（Java）
  });

  it('侧面贴邻也能建造（Java：上/下/侧面均可）', () => {
    const w = floorWorld('build-side');
    w.setBlock(0, 41, 0, K('copper_block'));
    w.setBlock(1, 41, 0, K('pumpkin'));
    expect(tryBuildCopperGolem(w, 1, 41, 0)).toBe(true);
    expect(w.getBlock(0, 41, 0)).toBe(K('copper_chest'));
    expect(w.getBlock(1, 41, 0)).toBe(AIR);
    expect(mobs.some((m) => m.type === 'copper_golem')).toBe(true);
  });

  it('无铜块相邻 / 触发位不是南瓜：不建造、世界不变', () => {
    const w = floorWorld('build-none');
    w.setBlock(0, 41, 0, K('pumpkin'));
    expect(tryBuildCopperGolem(w, 0, 41, 0)).toBe(false);
    expect(w.getBlock(0, 41, 0)).toBe(K('pumpkin'));
    expect(tryBuildCopperGolem(w, 5, 41, 5)).toBe(false); // 石头位置
    expect(mobs).toHaveLength(0);
  });
});

describe('铜傀儡搬运（铜箱取 ≤16 → 目标箱放：同类优先/空位兜底/无目标不搬/冷却 3s）', () => {
  const COPPER = '0,41,4';

  /** 铜箱 (0,41,4) + 傀儡 (1.2,41,4.5)：目标箱按用例另摆（均在交接距离内布局，免走动时序误差） */
  function golemWorld(name: string, copperItems: () => void): World {
    const w = floorWorld(name);
    w.setBlock(0, 41, 4, K('copper_chest'));
    copperItems();
    spawnMobAt('copper_golem', 1.2, 41, 4.5);
    return w;
  }

  it('同类优先：已有同类未满的箱优先于更近的空箱', () => {
    const w = golemWorld('haul-priority', () => {
      getStorage(COPPER)[0] = { kind: 'block', id: STONE, count: 20 };
    });
    w.setBlock(2, 41, 4, K('chest')); // 箱 A（1.3 格远）：已有 1 石头
    getStorage('2,41,4')[0] = { kind: 'block', id: STONE, count: 1 };
    w.setBlock(1, 41, 3, K('chest')); // 箱 B（更近 ~1.0 格）：全空
    step(w, 2);
    expect(blockCount('2,41,4', STONE)).toBe(17); // 1 + 16：同类未满优先
    expect(blockCount('1,41,3', STONE)).toBe(0); // 更近的空箱不被选
    expect(blockCount(COPPER, STONE)).toBe(4); // 20 - 16
  });

  it('空位兜底：无同类箱时放进有空位的箱', () => {
    const w = golemWorld('haul-fallback', () => {
      getStorage(COPPER)[0] = { kind: 'block', id: STONE, count: 20 };
    });
    w.setBlock(2, 41, 4, K('chest')); // 全空箱
    step(w, 2);
    expect(blockCount('2,41,4', STONE)).toBe(16);
    expect(blockCount(COPPER, STONE)).toBe(4);
  });

  it('无目标不搬：范围内没有任何普通箱时铜箱物品不动、傀儡空手', () => {
    const w = golemWorld('haul-no-target', () => {
      getStorage(COPPER)[0] = { kind: 'block', id: STONE, count: 20 };
    });
    step(w, 4);
    expect(blockCount(COPPER, STONE)).toBe(20);
    const g = mobs.find((m) => m.type === 'copper_golem')!;
    expect(g.carrying).toBeUndefined();
  });

  it('搬运冷却 ~3s：一次放入后冷却期内不搬第二次', () => {
    const w = golemWorld('haul-cooldown', () => {
      getStorage(COPPER)[0] = { kind: 'block', id: STONE, count: 64 };
    });
    w.setBlock(2, 41, 4, K('chest'));
    step(w, 2); // 第一次交接完成（取 ~0.1s + 停 0.6s + 放 ~0.7s）
    expect(blockCount('2,41,4', STONE)).toBe(16);
    step(w, 1.5); // t≈3.5：仍在 3s 冷却内
    expect(blockCount('2,41,4', STONE)).toBe(16);
    step(w, 1.5); // t≈5：冷却已过，第二组 16 到位
    expect(blockCount('2,41,4', STONE)).toBe(32);
  });

  it('超 32 格水平范围的目标箱不可达', () => {
    const w = golemWorld('haul-range', () => {
      getStorage(COPPER)[0] = { kind: 'block', id: STONE, count: 20 };
    });
    w.setBlock(40, 41, 4, K('chest')); // 距傀儡 ~38.8 格 > 32
    step(w, 4);
    expect(blockCount('40,41,4', STONE)).toBe(0);
    expect(blockCount(COPPER, STONE)).toBe(20);
  });
});

describe('铜傀儡掉落（Java：铜锭 2-3；搬运中的物品随死亡掉落）', () => {
  it('击杀掉 2-3 铜锭 + 手持物', () => {
    const w = floorWorld('golem-drops');
    const g = spawnMobAt('copper_golem', 0.5, 41, 0.5);
    g.carrying = { kind: 'material', material: 'coal', count: 16 };
    damageMob(g, 999, { x: 1, z: 1 }, 0, w);
    const copper = itemDrops
      .filter((d) => d.drop.kind === 'material' && d.drop.material === 'copper_ingot')
      .reduce((n, d) => n + d.count, 0);
    expect(copper).toBeGreaterThanOrEqual(2);
    expect(copper).toBeLessThanOrEqual(3);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'coal' && d.count === 16)).toBe(true);
    expect(g.carrying).toBeUndefined();
  });
});
