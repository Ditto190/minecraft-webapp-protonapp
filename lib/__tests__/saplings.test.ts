// 树苗生长与树叶凋零

import { describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY } from '../blocks';
import { worldClock } from '../game';
import { VOID_TERRAIN } from '../noise';
import { growTree, isLeavesId, leafDistanceToLog, notifyBlockSet, markPlacedLeaves, tickSaplings } from '../saplings';
import { World } from '../world';

function fillLeaves(w: World, cx: number, cy: number, cz: number, r: number, leaf: number): void {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let z = cz - r; z <= cz + r; z++) {
        w.setBlock(x, y, z, leaf);
      }
    }
  }
}

/** 区域内所有树叶的 distance 均 ≤6（回归：新凋零模型不误杀树自己长的树冠） */
function expectCanopyWithin6(w: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  let leaves = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        if (!isLeavesId(w.getBlock(x, y, z))) continue;
        expect(leafDistanceToLog(w, x, y, z)).toBeLessThanOrEqual(6);
        leaves++;
      }
    }
  }
  expect(leaves).toBeGreaterThan(0);
}

describe('树苗与树叶', () => {
  it('树苗到时间会长成树（干 4-6 高 + 叶）', () => {
    worldClock.t = 0.3; // 白天
    const w = new World('sapling-grow', undefined, VOID_TERRAIN);
    const oak = BLOCK_BY_KEY.oak_sapling.id;
    w.setBlock(8, 30, 8, oak);
    w.chunks.get('0,0')!.sky.fill(15); // MC：光照 ≥9 才生长
    // 触发足够多生长刻（1/25 概率 × 多次 2s tick，统计上必中；失败重试空间有限
    let grown = false;
    for (let i = 0; i < 200 && !grown; i++) {
      tickSaplings(w, 2);
      grown = w.getBlock(8, 30, 8) === BLOCK_BY_KEY.log.id;
    }
    expect(grown).toBe(true);
    expect(w.getBlock(8, 33, 8)).toBe(BLOCK_BY_KEY.log.id);
    // 该位置种子下橡树干 H=5，冠层 blob 底层在 y=33（Java 半径 2 冠，5×5 覆盖 x±2）
    expect(w.getBlock(9, 33, 8)).toBe(BLOCK_BY_KEY.leaves.id);
  });

  it('光照不足（<9）的树苗永不生长（MC 规则）', () => {
    worldClock.t = 0.3; // 白天
    const w = new World('sapling-dark', undefined, VOID_TERRAIN);
    const oak = BLOCK_BY_KEY.oak_sapling.id;
    w.setBlock(8, 30, 8, oak);
    // 模拟遮光后的光照状态（虚空世界 chunk 创建时 cascadeLight 会灌满天空光，此处清零等价于封闭空间）
    w.chunks.get('0,0')!.sky.fill(0);
    for (let i = 0; i < 200; i++) tickSaplings(w, 2);
    expect(w.getBlock(8, 30, 8)).toBe(oak);
  });

  it('深色橡木：单苗永不生长（MC 2×2 规则）', () => {
    worldClock.t = 0.3;
    const w = new World('dark-oak-single', undefined, VOID_TERRAIN);
    const s = BLOCK_BY_KEY.dark_oak_sapling.id;
    w.setBlock(8, 30, 8, s);
    w.chunks.get('0,0')!.sky.fill(15);
    for (let i = 0; i < 200; i++) tickSaplings(w, 2);
    expect(w.getBlock(8, 30, 8)).toBe(s);
  });

  it('深色橡木：2×2 四棵苗长成粗干树并同消四苗', () => {
    worldClock.t = 0.3;
    const w = new World('dark-oak-2x2', undefined, VOID_TERRAIN);
    const s = BLOCK_BY_KEY.dark_oak_sapling.id;
    for (const dx of [0, 1]) for (const dz of [0, 1]) w.setBlock(8 + dx, 30, 8 + dz, s);
    w.chunks.get('0,0')!.sky.fill(15);
    let grown = false;
    for (let i = 0; i < 400 && !grown; i++) {
      tickSaplings(w, 2);
      grown = w.getBlock(8, 30, 8) === BLOCK_BY_KEY.dark_oak_log.id;
    }
    expect(grown).toBe(true);
    // 四棵苗全被 2×2 粗干取代
    for (const dx of [0, 1]) for (const dz of [0, 1]) expect(w.getBlock(8 + dx, 30, 8 + dz)).toBe(BLOCK_BY_KEY.dark_oak_log.id);
  });

  it('丛林：单苗长普通丛林树（单柱高干，非 2×2 粗干）', () => {
    worldClock.t = 0.3;
    const w = new World('jungle-single', undefined, VOID_TERRAIN);
    const s = BLOCK_BY_KEY.jungle_sapling.id;
    w.setBlock(8, 30, 8, s);
    w.chunks.get('0,0')!.sky.fill(15);
    let grown = false;
    for (let i = 0; i < 400 && !grown; i++) {
      tickSaplings(w, 2);
      grown = w.getBlock(8, 30, 8) === BLOCK_BY_KEY.jungle_log.id;
    }
    expect(grown).toBe(true);
    // 单柱干（邻列无干）且高 ≥10（地表 29 + 干高 10）
    expect(w.getBlock(9, 30, 8)).not.toBe(BLOCK_BY_KEY.jungle_log.id);
    expect(w.getBlock(8, 39, 8)).toBe(BLOCK_BY_KEY.jungle_log.id);
  });

  it('丛林：2×2 四棵苗长成巨树（2×2 粗干高 ≥18）并同消四苗', () => {
    worldClock.t = 0.3;
    const w = new World('jungle-2x2', undefined, VOID_TERRAIN);
    const s = BLOCK_BY_KEY.jungle_sapling.id;
    for (const dx of [0, 1]) for (const dz of [0, 1]) w.setBlock(8 + dx, 30, 8 + dz, s);
    w.chunks.get('0,0')!.sky.fill(15);
    let grown = false;
    for (let i = 0; i < 400 && !grown; i++) {
      tickSaplings(w, 2);
      grown = w.getBlock(8, 30, 8) === BLOCK_BY_KEY.jungle_log.id;
    }
    expect(grown).toBe(true);
    // 四棵苗全被 2×2 粗干取代，且粗干贯通到 y=47（地表 29 + 最低干高 18）
    for (const dx of [0, 1]) {
      for (const dz of [0, 1]) {
        expect(w.getBlock(8 + dx, 30, 8 + dz)).toBe(BLOCK_BY_KEY.jungle_log.id);
        expect(w.getBlock(8 + dx, 47, 8 + dz)).toBe(BLOCK_BY_KEY.jungle_log.id);
      }
    }
  });

  it('distance 模型：隔空贴着原木（4 格内）但无树叶通路的浮叶枯萎', () => {
    const w = new World('leaf-float', undefined, VOID_TERRAIN);
    const log = BLOCK_BY_KEY.log.id;
    const leaf = BLOCK_BY_KEY.leaves.id;
    w.setBlock(20, 30, 8, log); // 独立原木：距浮叶 3 格（旧立方粗判会判活）
    w.setBlock(17, 30, 8, leaf); // 与原木之间是空气，无树叶通路（Java distance=∞）
    // 触发凋零扫描：在浮叶 6 格内放一根原木再砍掉
    w.setBlock(14, 30, 8, log);
    const old = w.getBlock(14, 30, 8);
    w.setBlock(14, 30, 8, AIR);
    notifyBlockSet(w, 14, 30, 8, old, AIR);
    for (let i = 0; i < 40; i++) tickSaplings(w, 2);
    expect(w.getBlock(17, 30, 8)).toBe(AIR); // 无树叶通路：枯
    expect(w.getBlock(20, 30, 8)).toBe(log); // 原木本身不动
  });

  it('distance 模型：沿枝叶延伸 6 格的叶存活，第 7 格枯萎', () => {
    const w = new World('leaf-chain', undefined, VOID_TERRAIN);
    const log = BLOCK_BY_KEY.log.id;
    const leaf = BLOCK_BY_KEY.leaves.id;
    w.setBlock(8, 30, 8, log);
    for (let i = 1; i <= 7; i++) w.setBlock(8 + i, 30, 8, leaf); // 7 格叶链：distance 1-7
    // 触发扫描（覆盖整条链）：放一根无关原木再砍掉
    w.setBlock(9, 32, 8, log);
    const old = w.getBlock(9, 32, 8);
    w.setBlock(9, 32, 8, AIR);
    notifyBlockSet(w, 9, 32, 8, old, AIR);
    for (let i = 0; i < 40; i++) tickSaplings(w, 2);
    for (let i = 1; i <= 6; i++) expect(w.getBlock(8 + i, 30, 8)).toBe(leaf); // distance ≤6 全活
    expect(w.getBlock(15, 30, 8)).toBe(AIR); // distance=7 枯
  });

  it('回归：各树种（含丛林巨树）树冠叶 distance 均 ≤6，新凋零模型不自枯', () => {
    for (const kind of ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry'] as const) {
      const w = new World(`tree-dist-${kind}`, undefined, VOID_TERRAIN);
      growTree(w, 8, 30, 8, kind);
      expectCanopyWithin6(w, 0, 28, 0, 16, 40, 16);
    }
    // 丛林巨树（干高至 24 + 侧枝，扫描区域放宽）
    const w = new World('tree-dist-mega-jungle', undefined, VOID_TERRAIN);
    growTree(w, 8, 30, 8, 'jungle', true);
    expectCanopyWithin6(w, 0, 28, 0, 16, 56, 16);
  });

  it('砍光原木后树叶逐级枯萎，远处有原木供养的不枯', () => {
    const w = new World('leaf-decay', undefined, VOID_TERRAIN);
    const log = BLOCK_BY_KEY.log.id;
    const leaf = BLOCK_BY_KEY.leaves.id;
    // 一棵树：干 + 叶
    for (let y = 30; y < 34; y++) w.setBlock(8, y, 8, log);
    fillLeaves(w, 8, 33, 8, 2, leaf);
    // 远处另一棵保叶树
    for (let y = 30; y < 34; y++) w.setBlock(15, y, 8, log);
    fillLeaves(w, 15, 33, 8, 1, leaf);
    // 砍掉近树的干
    for (let y = 30; y < 34; y++) {
      const old = w.getBlock(8, y, 8);
      w.setBlock(8, y, 8, AIR);
      notifyBlockSet(w, 8, y, 8, old, AIR);
    }
    for (let i = 0; i < 40; i++) tickSaplings(w, 2);
    // 近树叶子应全部枯萎
    let left = 0;
    for (let x = 6; x <= 10; x++) {
      for (let z = 6; z <= 10; z++) {
        for (let y = 31; y <= 35; y++) {
          if (w.getBlock(x, y, z) === leaf) left++;
        }
      }
    }
    expect(left).toBe(0);
    // 远树叶子保留
    expect(w.getBlock(14, 33, 8)).toBe(leaf);
  });

  it('玩家放置的树叶（persistent 登记）不凋零；同批断供的普通树叶枯萎', () => {
    const w = new World('leaf-persistent', undefined, VOID_TERRAIN);
    const log = BLOCK_BY_KEY.log.id;
    const leaf = BLOCK_BY_KEY.leaves.id;
    for (let y = 30; y < 33; y++) w.setBlock(8, y, 8, log);
    w.setBlock(10, 32, 8, leaf); // 普通树叶：断供会枯
    w.setBlock(12, 32, 8, leaf); // 玩家放置：登记 persistent（Java）
    markPlacedLeaves(12, 32, 8);
    // 砍掉树干：5 格内树叶（含这两片）进入凋零队列
    for (let y = 30; y < 33; y++) {
      const old = w.getBlock(8, y, 8);
      w.setBlock(8, y, 8, AIR);
      notifyBlockSet(w, 8, y, 8, old, AIR);
    }
    for (let i = 0; i < 40; i++) tickSaplings(w, 2);
    expect(w.getBlock(10, 32, 8)).toBe(AIR); // 断供普通树叶枯萎
    expect(w.getBlock(12, 32, 8)).toBe(leaf); // persistent 永不凋零（级联扫到也跳过）
  });

  it('persistent 树叶被破坏后除名：同位置再有的树叶恢复可凋零', () => {
    const w = new World('leaf-unmark', undefined, VOID_TERRAIN);
    const log = BLOCK_BY_KEY.log.id;
    const leaf = BLOCK_BY_KEY.leaves.id;
    w.setBlock(12, 32, 8, leaf);
    markPlacedLeaves(12, 32, 8);
    w.setBlock(12, 32, 8, AIR); // 破坏：setBlock 钩子自动除名
    w.setBlock(12, 32, 8, leaf); // 非玩家途径再次出现（不登记）
    // 旁边放原木再砍，触发凋零队列
    w.setBlock(10, 32, 8, log);
    const old = w.getBlock(10, 32, 8);
    w.setBlock(10, 32, 8, AIR);
    notifyBlockSet(w, 10, 32, 8, old, AIR);
    for (let i = 0; i < 40; i++) tickSaplings(w, 2);
    expect(w.getBlock(12, 32, 8)).toBe(AIR);
  });
});
