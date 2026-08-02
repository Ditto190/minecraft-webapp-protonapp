// 红石比较器：比较模式（背向≥两侧→背向电平）、减法模式、侧向、模式切换、分级输出

import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY, STONE } from '../blocks';
import { clearBrews, getBrew } from '../brewing';
import { clearFurnaces, getFurnace } from '../furnace';
import { VOID_TERRAIN } from '../noise';
import { clearRedstone, dustPowerAt, tickRedstone, toggleComparatorMode, toggleLever } from '../redstone';
import { RECIPES } from '../recipes';
import { clearStorages, getStorage } from '../storage';
import { World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;
const DUST = () => K('redstone_dust');

function setup(): World {
  clearRedstone();
  const w = new World('comparator-test', undefined, VOID_TERRAIN);
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
  return w;
}

beforeEach(() => {
  clearRedstone();
  clearStorages();
  clearFurnaces();
  clearBrews();
});

/** 粉链：火把 (0) → 粉 (1..n)，比较器朝东在 n+1，输出粉 n+2/n+3 */
function chainWithComparator(w: World, dustLen: number): void {
  w.setBlock(0, 30, 4, STONE);
  w.setBlock(0, 31, 4, K('redstone_torch'));
  for (let x = 1; x <= dustLen; x++) {
    w.setBlock(x, 30, 4, STONE);
    w.setBlock(x, 31, 4, DUST());
  }
  w.setBlock(dustLen + 1, 30, 4, STONE);
  w.setBlock(dustLen + 1, 31, 4, K('comparator_e'));
  w.setBlock(dustLen + 2, 30, 4, STONE);
  w.setBlock(dustLen + 2, 31, 4, DUST());
  w.setBlock(dustLen + 3, 30, 4, STONE);
  w.setBlock(dustLen + 3, 31, 4, DUST());
}

describe('比较器', () => {
  it('比较模式：背向电平原样输出（9 进 9 出，MC）', () => {
    const w = setup();
    chainWithComparator(w, 7); // 末端功率 9（火把 x0，粉 x1=15 逐格 -1）
    expect(dustPowerAt(7, 31, 4)).toBe(9);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1); // 结算重播
    expect(w.getBlock(8, 31, 4)).toBe(K('comparator_on_e'));
    expect(dustPowerAt(9, 31, 4)).toBe(9);
    expect(dustPowerAt(10, 31, 4)).toBe(8);
  });

  it('侧向 ≥ 背向时比较模式输出 0（MC）', () => {
    const w = setup();
    chainWithComparator(w, 7); // 背向 8
    // 南侧向供 10（火把经粉接到比较器侧面）
    w.setBlock(8, 30, 6, STONE);
    w.setBlock(8, 31, 6, K('redstone_torch'));
    w.setBlock(8, 30, 5, STONE);
    w.setBlock(8, 31, 5, DUST()); // 侧向粉 = 15
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(9, 31, 4)).toBe(0); // 9 < 15 → 输出 0
    // 撤掉侧向：恢复输出 9
    w.setBlock(8, 31, 5, 0);
    w.setBlock(8, 31, 6, 0);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(9, 31, 4)).toBe(9);
  });

  it('减法模式：输出 = 背向 − 侧向（9 − 0 → 9；9 − 15 → 0；9 − 6 → 3）', () => {
    const w = setup();
    chainWithComparator(w, 7); // 背向 9
    toggleComparatorMode(8, 31, 4); // 切减法
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(9, 31, 4)).toBe(9); // 无侧向：9 - 0 = 9
    // 侧向 15：火把直连比较器侧格
    w.setBlock(8, 30, 5, STONE);
    w.setBlock(8, 31, 5, DUST());
    w.setBlock(8, 30, 6, STONE);
    w.setBlock(8, 31, 6, K('redstone_torch'));
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(9, 31, 4)).toBe(0); // 9 - 15 → 0
    // 侧向降到 6（火把经 9 格粉衰减到侧面）：9 - 6 = 3
    w.setBlock(8, 31, 6, 0);
    w.setBlock(8, 31, 5, 0);
    w.setBlock(8, 30, 15, STONE);
    w.setBlock(8, 31, 15, K('redstone_torch'));
    for (let zz = 14; zz >= 5; zz--) {
      w.setBlock(8, 30, zz, STONE);
      w.setBlock(8, 31, zz, DUST());
    }
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(9, 31, 4)).toBe(3); // 9 - 6 = 3
  });

  it('拉杆经比较器点灯（端到端分级通过）', () => {
    const w = setup();
    w.setBlock(0, 30, 4, K('lever'));
    w.setBlock(1, 30, 4, K('comparator_e'));
    w.setBlock(2, 30, 4, STONE);
    w.setBlock(2, 31, 4, DUST());
    w.setBlock(3, 31, 4, K('redstone_lamp'));
    toggleLever(w, 0, 30, 4);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(3, 31, 4)).toBe(K('redstone_lamp_lit'));
  });

  it('比较器配方（MC：3 火把 + 1 石英 + 3 石头）', () => {
    const r = RECIPES.find((x) => x.id === 'comparator')!;
    expect(r.cost).toContainEqual({ item: `block:${K('redstone_torch')}`, count: 3 });
    expect(r.cost).toContainEqual({ item: 'material:quartz', count: 1 });
  });
});

describe('比较器输出特性（MC）', () => {
  it('输入→输出延迟 1 红石刻：当帧不结算，到期才输出', () => {
    const w = setup();
    chainWithComparator(w, 7); // 背向 9
    // 放置后未经 tick：输出未结算（MC：比较器有 1 红石刻延迟）
    expect(dustPowerAt(9, 31, 4)).toBe(0);
    tickRedstone(w, 0.05); // 未到 0.1s
    expect(dustPowerAt(9, 31, 4)).toBe(0);
    tickRedstone(w, 0.06); // 过 0.1s → 结算输出 9
    expect(dustPowerAt(9, 31, 4)).toBe(9);
    expect(w.getBlock(8, 31, 4)).toBe(K('comparator_on_e'));
    // 断输入同样延迟 1 红石刻才熄灭
    w.setBlock(0, 31, 4, 0);
    tickRedstone(w, 0.05);
    expect(dustPowerAt(9, 31, 4)).toBe(9);
    tickRedstone(w, 0.06);
    expect(dustPowerAt(9, 31, 4)).toBe(0);
    expect(w.getBlock(8, 31, 4)).toBe(K('comparator_e'));
  });

  it('强充能前方实心块：块外粉按输出电平导通（MC Java 强充能）', () => {
    const w = setup();
    w.setBlock(0, 30, 4, STONE);
    w.setBlock(0, 31, 4, K('redstone_torch'));
    for (let x = 1; x <= 7; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, DUST());
    }
    w.setBlock(8, 30, 4, STONE);
    w.setBlock(8, 31, 4, K('comparator_e')); // 背向粉功率 9
    w.setBlock(9, 31, 4, STONE); // 前方实心块 → 强充能 9 级
    w.setBlock(10, 30, 4, STONE);
    w.setBlock(10, 31, 4, DUST()); // 贴着被强充能的块
    w.setBlock(11, 30, 4, STONE);
    w.setBlock(11, 31, 4, DUST());
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(10, 31, 4)).toBe(9); // 强充能块按比较器输出电平驱动粉
    expect(dustPowerAt(11, 31, 4)).toBe(8);
  });

  it('激活前方元件：灯直连比较器输出面点亮（MC）', () => {
    const w = setup();
    w.setBlock(0, 30, 4, K('lever'));
    w.setBlock(1, 30, 4, K('comparator_e'));
    w.setBlock(2, 30, 4, K('redstone_lamp')); // 输出面直连，中间无粉
    toggleLever(w, 0, 30, 4);
    expect(w.getBlock(2, 30, 4)).toBe(K('redstone_lamp')); // 延迟未到不亮
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(2, 30, 4)).toBe(K('redstone_lamp_lit'));
    toggleLever(w, 0, 30, 4);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(2, 30, 4)).toBe(K('redstone_lamp'));
  });

  it('比较器读粉弱充能的方块取粉的实际电平（MC：非一律 15）', () => {
    const w = setup();
    // 衰减链末端粉功率 9，任何形态都弱充能正下方块 → 石块 9 级；比较器背向贴石块应读出 9
    w.setBlock(0, 30, 4, STONE);
    w.setBlock(0, 31, 4, K('redstone_torch'));
    for (let x = 1; x <= 7; x++) {
      w.setBlock(x, 30, 4, STONE);
      w.setBlock(x, 31, 4, DUST()); // 末端 (7,31,4) 功率 9
    }
    // (7,30,4) 石块被末端粉弱充能（正下方块）→ 9 级；比较器从 -z 侧读它
    w.setBlock(7, 30, 3, K('comparator_n')); // 背向 = (7,30,4) 石块
    w.setBlock(7, 29, 2, STONE);
    w.setBlock(7, 30, 2, DUST()); // 输出端粉（与链不对角相邻，不受干扰）
    expect(dustPowerAt(7, 31, 4)).toBe(9);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(7, 30, 3)).toBe(K('comparator_on_n'));
    expect(dustPowerAt(7, 30, 2)).toBe(9); // 输出 = 背向 9（读粉的实际电平，不是 15）
  });
});

describe('比较器容器检测（MC Java：signal = 1 + floor(Σ槽占比/槽位数×14)，空容器 0）', () => {
  /** 箱子 (0,30,4) → 比较器朝东 (1,30,4)，输出粉 (2,30,4)/(3,30,4) */
  function chestComparator(w: World): void {
    w.setBlock(0, 30, 4, K('chest'));
    w.setBlock(1, 30, 4, K('comparator_e')); // 背向 = (0,30,4) 箱子
    w.setBlock(2, 30, 4, DUST());
    w.setBlock(3, 30, 4, DUST());
  }

  it('满箱（27×64）输出 15', () => {
    const w = setup();
    const s = getStorage('0,30,4');
    for (let i = 0; i < s.length; i++) s[i] = { kind: 'block', id: STONE, count: 64 };
    chestComparator(w);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(1, 30, 4)).toBe(K('comparator_on_e'));
    expect(dustPowerAt(2, 30, 4)).toBe(15);
    expect(dustPowerAt(3, 30, 4)).toBe(14);
  });

  it('空箱输出 0', () => {
    const w = setup();
    chestComparator(w); // 无内容
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(w.getBlock(1, 30, 4)).toBe(K('comparator_e'));
    expect(dustPowerAt(2, 30, 4)).toBe(0);
  });

  it('半满中间值：14/27 槽满 → 8；内容变化随重算刷新（同一提交路径）', () => {
    const w = setup();
    chestComparator(w);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(0); // 空箱 0
    const s = getStorage('0,30,4');
    for (let i = 0; i < 14; i++) s[i] = { kind: 'block', id: STONE, count: 64 };
    // 内容变化不自带方块更新：邻近放块触发重算（MC 容器会发方块更新，这里走等价的重算路径）
    w.setBlock(2, 31, 4, STONE);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(8); // 1 + floor(14/27×14) = 1 + 7 = 8
  });

  it('单槽 32 个 → 1（Java 按槽占比，不按物品总数占比）', () => {
    const w = setup();
    const s = getStorage('0,30,4');
    s[0] = { kind: 'block', id: STONE, count: 32 };
    chestComparator(w);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(1); // 1 + floor((0.5/27)×14) = 1 + 0 = 1
  });

  it('熔炉 3 槽：输入槽满 → 1/3 → 5', () => {
    const w = setup();
    getFurnace('0,30,4').input = { item: 'material:coal', count: 64 };
    w.setBlock(0, 30, 4, K('furnace'));
    w.setBlock(1, 30, 4, K('comparator_e'));
    w.setBlock(2, 30, 4, DUST());
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(5); // 1 + floor((1/3)×14) = 1 + 4 = 5
  });

  it('酿造台 5 槽（MC Java 1.9+ 含燃料槽）：3 瓶药水 → 3/5 → 9', () => {
    const w = setup();
    const b = getBrew('0,30,4');
    b.potions = [
      { item: 'water_bottle', count: 1 },
      { item: 'water_bottle', count: 1 },
      { item: 'water_bottle', count: 1 },
    ];
    w.setBlock(0, 30, 4, K('brewing_stand'));
    w.setBlock(1, 30, 4, K('comparator_e'));
    w.setBlock(2, 30, 4, DUST());
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(9); // 1 + floor((3/5)×14) = 1 + 8 = 9
  });

  it('容器满度接入既有比较/减法逻辑：侧向 ≥ 满度时输出 0', () => {
    const w = setup();
    const s = getStorage('0,30,4');
    for (let i = 0; i < 14; i++) s[i] = { kind: 'block', id: STONE, count: 64 }; // 满度 8
    chestComparator(w);
    // 侧向 15：悬空火把直供侧向粉
    w.setBlock(1, 30, 6, K('redstone_torch'));
    w.setBlock(1, 30, 5, DUST()); // 15，贴比较器侧格
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(0); // 比较：8 < 15 → 0
    toggleComparatorMode(1, 30, 4); // 减法：8 − 15 → 0
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(0);
    // 撤掉侧向：恢复满度输出 8
    w.setBlock(1, 30, 5, 0);
    w.setBlock(1, 30, 6, 0);
    tickRedstone(w, 0.1);
    tickRedstone(w, 0.1);
    expect(dustPowerAt(2, 30, 4)).toBe(8);
  });
});
