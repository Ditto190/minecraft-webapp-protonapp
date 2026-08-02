// 流体传播：水位识别 + 下流水柱 + 落地扩散 + 冲毁非实心方块 + 瀑布满强度（falling）

import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, isWaterId, STONE, WATER, WATER_FLOW_1, WHEAT_CROP_0 } from '../blocks';
import { clearFluids, tickFluids, waterLevel } from '../fluids';
import { clearDrops, itemDrops } from '../items';
import { VOID_TERRAIN } from '../noise';
import { World } from '../world';

const FLOW = (n: number) => WATER_FLOW_1 + n - 1;

// 流体队列与掉落物列表是模块全局的：测试间必须清空，否则上一个测试的残留 key 会耗尽本测试的 tick budget / 污染掉落断言
beforeEach(() => {
  clearFluids();
  clearDrops();
});

describe('流体传播', () => {
  it('waterLevel 识别源/流水/非水', () => {
    expect(waterLevel(WATER)).toBe(0);
    expect(waterLevel(FLOW(1))).toBe(1);
    expect(waterLevel(FLOW(7))).toBe(7);
    expect(waterLevel(AIR)).toBe(-1);
    expect(waterLevel(STONE)).toBe(-1);
  });

  it('悬空水源向下流成水柱', () => {
    const w = new World('fluid-fall', undefined, VOID_TERRAIN);
    w.setBlock(8, 30, 8, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(w.getBlock(8, 29, 8)).toBe(FLOW(1));
    expect(w.getBlock(8, 25, 8)).toBe(FLOW(1));
    expect(w.getBlock(8, 21, 8)).toBe(FLOW(1));
  });

  it('落地后向四方扩散且等级递增（最多 7 级）', () => {
    const w = new World('fluid-spread', undefined, VOID_TERRAIN);
    for (let x = 2; x <= 10; x++) {
      for (let z = 2; z <= 10; z++) w.setBlock(x, 10, z, STONE);
    }
    w.setBlock(6, 11, 6, WATER);
    for (let i = 0; i < 6; i++) tickFluids(w, 256);
    // 四周 1 级
    expect(waterLevel(w.getBlock(7, 11, 6))).toBe(1);
    expect(waterLevel(w.getBlock(5, 11, 6))).toBe(1);
    expect(waterLevel(w.getBlock(6, 11, 7))).toBe(1);
    // 继续扩散出 2 级
    for (let i = 0; i < 6; i++) tickFluids(w, 256);
    expect(waterLevel(w.getBlock(8, 11, 6))).toBe(2);
    // 源永不降级/消失
    expect(w.getBlock(6, 11, 6)).toBe(WATER);
  });

  it('水遇岩浆源：岩浆变黑曜石', () => {
    const w = new World('fluid-lava', undefined, VOID_TERRAIN);
    for (let x = 2; x <= 8; x++) w.setBlock(x, 19, 6, STONE); // 地板让水横向扩散
    w.setBlock(6, 20, 6, BLOCK_BY_KEY.lava.id);
    w.setBlock(4, 20, 6, WATER);
    for (let i = 0; i < 8; i++) tickFluids(w, 128);
    expect(w.getBlock(6, 20, 6)).toBe(BLOCK_BY_KEY.obsidian.id);
  });

  it('扩散不超过 7 级', () => {
    const w = new World('fluid-max', undefined, VOID_TERRAIN);
    for (let x = 0; x < 32; x++) w.setBlock(x, 10, 0, STONE);
    w.setBlock(0, 11, 0, WATER);
    for (let i = 0; i < 30; i++) tickFluids(w, 512);
    // 最远处等级 ≤ 7，且不会无限传播
    for (let x = 1; x < 32; x++) {
      const lv = waterLevel(w.getBlock(x, 11, 0));
      expect(lv === -1 || (lv >= 1 && lv <= 7)).toBe(true);
    }
    expect(waterLevel(w.getBlock(31, 11, 0))).not.toBe(8);
  });

  it('挖掉水源后流水逐级消退', () => {
    const w = new World('fluid-decay', undefined, VOID_TERRAIN);
    for (let x = 2; x <= 10; x++) {
      for (let z = 2; z <= 10; z++) w.setBlock(x, 10, z, STONE);
    }
    w.setBlock(6, 11, 6, WATER);
    for (let i = 0; i < 6; i++) tickFluids(w, 256);
    expect(waterLevel(w.getBlock(8, 11, 6))).toBe(2);
    // 移除水源：流水失去上游，应逐级消退
    w.setBlock(6, 11, 6, AIR);
    for (let i = 0; i < 12; i++) tickFluids(w, 256);
    expect(w.getBlock(6, 11, 6)).toBe(AIR);
    expect(w.getBlock(7, 11, 6)).toBe(AIR);
    expect(w.getBlock(8, 11, 6)).toBe(AIR);
  });

  it('悬空水柱在上游移除后自顶向下消退', () => {
    const w = new World('fluid-decay-col', undefined, VOID_TERRAIN);
    w.setBlock(8, 30, 8, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(w.getBlock(8, 25, 8)).toBe(WATER_FLOW_1);
    w.setBlock(8, 30, 8, AIR);
    for (let i = 0; i < 12; i++) tickFluids(w, 128);
    expect(w.getBlock(8, 25, 8)).toBe(AIR);
  });

  it('无限水源：两个水源夹一格流水且下方实心 → 成源', () => {
    const w = new World('fluid-infinite', undefined, VOID_TERRAIN);
    // 3×3 石平台，东西两个水源，中间留空
    for (let x = 2; x <= 6; x++) {
      for (let z = 2; z <= 6; z++) w.setBlock(x, 10, z, STONE);
    }
    w.setBlock(3, 11, 4, WATER);
    w.setBlock(5, 11, 4, WATER);
    w.setBlock(4, 11, 4, WATER_FLOW_1); // 中间的 1 级流水
    tickFluids(w, 128);
    expect(w.getBlock(4, 11, 4)).toBe(WATER); // MC：2×2 无限水成源
  });

  it('加载区边缘倒水：不向未加载 chunk 传播，不触发隐式生成', () => {
    const w = new World('fluid-edge', undefined, VOID_TERRAIN);
    w.getChunk(0, 0);
    for (let x = 0; x <= 15; x++) w.setBlock(x, 10, 8, STONE); // 地板让水横向扩散
    w.setBlock(15, 11, 8, WATER); // chunk 东缘的水源，东侧 (1,0) 未加载
    for (let i = 0; i < 8; i++) tickFluids(w, 128);
    expect(w.chunks.size).toBe(1); // 邻格读取/扩散都没有隐式生成新 chunk
    expect(w.chunks.has('1,0')).toBe(false);
    // 已加载区域内照常扩散
    expect(waterLevel(w.getBlock(14, 11, 8))).toBe(1);
  });

  it('水扩散按拍推进：同一拍不级联到底（回归：平地水源曾 0.4s 铺满 7 级）', () => {
    const w = new World('fluid-batch', undefined, VOID_TERRAIN);
    for (let x = 0; x < 16; x++) w.setBlock(x, 10, 0, STONE);
    w.setBlock(0, 11, 0, WATER);
    tickFluids(w, 512);
    expect(waterLevel(w.getBlock(1, 11, 0))).toBe(1); // 第 1 拍：源扩散出 1 级
    expect(w.getBlock(2, 11, 0)).toBe(AIR); // 修复前同拍沿队列级联到底（预入队的地面空气格也会被拍内访问）
    for (let i = 0; i < 6; i++) tickFluids(w, 512);
    expect(waterLevel(w.getBlock(7, 11, 0))).toBe(7); // 逐拍推进后铺满 7 级（MC 每级 5 tick=0.25s，本项目 0.4s/级同量级）
    expect(w.getBlock(8, 11, 0)).toBe(AIR); // 7 级封顶不外溢
  });

  it('混凝土粉末遇水固化：侧向流入的粉末变对应颜色混凝土（MC：邻接水立即固化）', () => {
    const w = new World('fluid-concrete-side', undefined, VOID_TERRAIN);
    for (let x = 2; x <= 8; x++) w.setBlock(x, 10, 6, STONE);
    w.setBlock(4, 11, 6, BLOCK_BY_KEY.blue_concrete_powder.id);
    w.setBlock(6, 11, 6, WATER);
    for (let i = 0; i < 8; i++) tickFluids(w, 128);
    expect(w.getBlock(4, 11, 6)).toBe(BLOCK_BY_KEY.blue_concrete.id); // 固化成同色混凝土，不被流水占据
  });

  it('混凝土粉末遇水固化：水压在粉末上方同样固化（含流入格）', () => {
    const w = new World('fluid-concrete-top', undefined, VOID_TERRAIN);
    w.setBlock(4, 10, 6, STONE);
    w.setBlock(4, 11, 6, BLOCK_BY_KEY.red_concrete_powder.id);
    w.setBlock(4, 12, 6, WATER); // 粉末正上方放水
    for (let i = 0; i < 4; i++) tickFluids(w, 128);
    expect(w.getBlock(4, 11, 6)).toBe(BLOCK_BY_KEY.red_concrete.id); // MC：粉末固化挡水，水不占据该格
  });

  it('水源瀑布落地水平扩满 7 格（MC falling：下落保持源强度，修复前 1 级柱落地只扩 6 格）', () => {
    const w = new World('fluid-waterfall', undefined, VOID_TERRAIN);
    for (let x = 0; x <= 15; x++) {
      for (let z = 4; z <= 12; z++) w.setBlock(x, 10, z, STONE);
    }
    w.setBlock(4, 20, 8, WATER); // 悬空水源，落点 (4,11,8)
    for (let i = 0; i < 30; i++) tickFluids(w, 512);
    expect(w.getBlock(4, 19, 8)).toBe(FLOW(1)); // 水柱格仍是 1 级流 id（falling 不改变存档 id，渲染/读档不受影响）
    expect(waterLevel(w.getBlock(5, 11, 8))).toBe(1); // 落地从 1 级起扩
    expect(waterLevel(w.getBlock(11, 11, 8))).toBe(7); // 扩满 7 格（MC 瀑布）
    expect(w.getBlock(12, 11, 8)).toBe(AIR); // 第 8 格不外溢
    expect(w.getBlock(4, 20, 8)).toBe(WATER); // 源保留
  });

  it('下落水不转源：瀑布落点夹在两源之间仍保持流水（MC：falling 永不转源）', () => {
    const w = new World('fluid-fall-no-source', undefined, VOID_TERRAIN);
    for (let x = 2; x <= 6; x++) {
      for (let z = 2; z <= 6; z++) w.setBlock(x, 10, z, STONE);
    }
    w.setBlock(4, 20, 4, WATER);
    for (let i = 0; i < 15; i++) tickFluids(w, 256); // 先让瀑布建成：落点 (4,11,4) 是 falling 格
    w.setBlock(3, 11, 4, WATER);
    w.setBlock(5, 11, 4, WATER); // 两侧补水源（普通 1 级流在此布局会转源，见上方无限水测试）
    for (let i = 0; i < 6; i++) tickFluids(w, 256);
    expect(w.getBlock(4, 11, 4)).toBe(FLOW(1)); // falling 格不满足成源条件（MC）
  });
});

describe('流体冲毁非实心方块（MC：水破坏并掉落、岩浆只销毁）', () => {
  /** 铺一行石头地板（y=10），东端放目标方块，西端放水/岩浆源 */
  function washSetup(target: number): World {
    const w = new World(`fluid-wash-${target}`, undefined, VOID_TERRAIN);
    for (let x = 2; x <= 10; x++) w.setBlock(x, 10, 6, STONE);
    w.setBlock(8, 11, 6, target);
    return w;
  }

  const dropCount = (blockId: number): number =>
    itemDrops.filter((d) => d.drop.kind === 'block' && d.drop.blockId === blockId).reduce((n, d) => n + d.count, 0);
  const materialCount = (material: string): number =>
    itemDrops.filter((d) => d.drop.kind === 'material' && d.drop.material === material).reduce((n, d) => n + d.count, 0);

  it('水冲毁花草：破坏并以掉落物弹出（收割水流）', () => {
    const w = washSetup(BLOCK_BY_KEY.dandelion.id);
    w.setBlock(4, 11, 6, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(isWaterId(w.getBlock(8, 11, 6))).toBe(true); // 花被流水占据
    expect(dropCount(BLOCK_BY_KEY.dandelion.id)).toBe(1); // 弹出 1 朵蒲公英
  });

  it('水熄火把：火把被冲毁掉落', () => {
    const w = washSetup(BLOCK_BY_KEY.torch.id);
    w.setBlock(4, 11, 6, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(isWaterId(w.getBlock(8, 11, 6))).toBe(true);
    expect(dropCount(BLOCK_BY_KEY.torch.id)).toBe(1);
  });

  it('甘蔗整株冲毁：上方各节一并破坏且都掉落（MC 柱状植物规则）', () => {
    const w = washSetup(BLOCK_BY_KEY.sugar_cane.id);
    w.setBlock(8, 12, 6, BLOCK_BY_KEY.sugar_cane.id);
    w.setBlock(8, 13, 6, BLOCK_BY_KEY.sugar_cane.id);
    w.setBlock(4, 11, 6, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(isWaterId(w.getBlock(8, 11, 6))).toBe(true);
    expect(w.getBlock(8, 12, 6)).toBe(AIR); // 上方各节一并清除
    expect(w.getBlock(8, 13, 6)).toBe(AIR);
    expect(dropCount(BLOCK_BY_KEY.sugar_cane.id)).toBe(3); // 三节都掉落
  });

  it('收割水流：成熟小麦掉小麦+种子，未熟只掉种子（同挖掘规则）', () => {
    const w = washSetup(WHEAT_CROP_0 + 7); // 成熟小麦
    w.setBlock(9, 11, 6, WHEAT_CROP_0 + 3); // 未熟小麦
    w.setBlock(4, 11, 6, WATER);
    for (let i = 0; i < 12; i++) tickFluids(w, 128);
    expect(isWaterId(w.getBlock(8, 11, 6))).toBe(true);
    expect(isWaterId(w.getBlock(9, 11, 6))).toBe(true);
    expect(materialCount('wheat')).toBe(1); // 成熟掉 1 小麦
    expect(materialCount('wheat_seeds')).toBeGreaterThanOrEqual(1); // 未熟 1 种子 + 成熟 0-2 种子
  });

  it('雪层被冲毁掉雪球（同挖掘非精准掉落）', () => {
    const w = washSetup(BLOCK_BY_KEY.snow_layer.id);
    w.setBlock(4, 11, 6, WATER);
    for (let i = 0; i < 10; i++) tickFluids(w, 128);
    expect(isWaterId(w.getBlock(8, 11, 6))).toBe(true);
    expect(materialCount('snowball')).toBe(1); // MC：单层雪掉 1 雪球
  });
});
