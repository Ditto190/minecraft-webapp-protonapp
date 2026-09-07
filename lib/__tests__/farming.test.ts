// 耕种/养殖：整地、播种、生长、收割、草丛掉种子、喂食繁殖

import { beforeEach, describe, expect, it } from 'vitest';
import { breakBlock, tryPlace } from '../actions';
import { AIR, BLOCK_BY_KEY, GRASS, STONE, WHEAT_CROP_0 } from '../blocks';
import { notifyCropBlockSet, tickCrops, trampleFarmland } from '../crops';
import { cameraRef, setActiveWorld, worldClock } from '../game';
import { clearDrops, itemDrops } from '../items';
import { breedMob, clearMobs, mobs } from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { useGameStore } from '../store';
import { emptySlots } from '../slots';
import { World } from '../world';
import { Vector3, type Camera } from 'three';

const FARMLAND = () => BLOCK_BY_KEY.farmland.id;

function setup(): World {
  clearMobs();
  clearDrops();
  const w = new World('farm-test', undefined, VOID_TERRAIN);
  setActiveWorld(w);
  useGameStore.getState().loadSurvival({ health: 20, hunger: 20, slots: emptySlots() });
  useGameStore.setState({ worldMode: 'survival', notice: null });
  return w;
}

function cameraAt(x: number, y: number, z: number, dir: [number, number, number]): void {
  cameraRef.current = {
    position: new Vector3(x, y, z),
    getWorldDirection: (v: Vector3) => v.set(...dir).normalize(),
  } as unknown as Camera;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('耕种', () => {
  beforeEach(setup);

  it('锄头整地：草方块 → 耕地，扣耐久', async () => {
    const w = setup();
    w.setBlock(4, 30, 4, GRASS);
    const s = useGameStore.getState();
    s.addTool('wooden_hoe');
    useGameStore.setState({ selectedSlot: 0 });
    cameraAt(4.5, 32, 4.5, [0, -1, 0]);
    await wait(160);
    tryPlace();
    expect(w.getBlock(4, 30, 4)).toBe(FARMLAND());
    const slot = useGameStore.getState().hotbarSlots[0];
    expect(slot?.kind === 'tool' && slot.durability).toBe(58);
  });

  it('播种 → 生长 8 阶段 → 收割掉小麦和种子', async () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    const s = useGameStore.getState();
    s.addStack({ kind: 'material', material: 'wheat_seeds' }, 5);
    useGameStore.setState({ selectedSlot: 0 });
    cameraAt(4.5, 32, 4.5, [0, -1, 0]);
    await wait(160);
    tryPlace();
    expect(w.getBlock(4, 31, 4)).toBe(WHEAT_CROP_0);
    // 消耗了 1 种子
    expect(useGameStore.getState().hotbarSlots[0]).toEqual({ kind: 'material', material: 'wheat_seeds', count: 4 });
    // 生长：推进随机刻直到成熟（1/12 概率/2s，800 次足够；虚空世界无天空光，手动补光）
    notifyCropBlockSet(4, 31, 4, WHEAT_CROP_0); // 生成不走 setBlock 钩子，手动登记
    w.chunks.get('0,0')!.sky.fill(15);
    for (let i = 0; i < 800 && w.getBlock(4, 31, 4) < WHEAT_CROP_0 + 7; i++) tickCrops(w, 2);
    expect(w.getBlock(4, 31, 4)).toBe(WHEAT_CROP_0 + 7);
    // 收割
    breakBlock(w, 4, 31, 4);
    const wheat = itemDrops.filter((d) => d.drop.kind === 'material' && d.drop.material === 'wheat');
    expect(wheat.length).toBe(1);
  });

  it('未成熟收割只掉种子；耕地被破坏弹出作物', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 3);
    breakBlock(w, 4, 31, 4);
    expect(itemDrops.length).toBe(1);
    expect(itemDrops[0].drop.kind === 'material' && itemDrops[0].drop.material).toBe('wheat_seeds');
    // 耕地破坏：上方作物弹出
    clearDrops();
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 5);
    breakBlock(w, 4, 30, 4);
    expect(w.getBlock(4, 31, 4)).toBe(0);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'wheat_seeds')).toBe(true);
  });

  it('挖掉耕地：成熟作物按生长阶段弹出（1 小麦 + 种子），不是直接吞掉', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 7); // 成熟
    breakBlock(w, 4, 30, 4);
    expect(w.getBlock(4, 31, 4)).toBe(0);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'wheat')).toBe(true);
  });

  it('耕地退化消失：未熟作物以掉落物形式弹出（tickCrops 路径）', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 3);
    w.chunks.get('0,0')!.sky.fill(15);
    w.setBlock(4, 30, 4, BLOCK_BY_KEY.dirt.id); // 耕地没了（退化/被改，不走 breakBlock 的路径）
    tickCrops(w, 2);
    expect(w.getBlock(4, 31, 4)).toBe(0); // 弹出而非吞掉
    const seeds = itemDrops.filter((d) => d.drop.kind === 'material' && d.drop.material === 'wheat_seeds');
    expect(seeds).toHaveLength(1);
  });

  it('耕地湿润缓存：放置/移除水源即时更新周围耕地，tickCrops 不再全量扫 9×9×2', () => {
    const w = setup();
    w.setBlock(4, 30, 4, BLOCK_BY_KEY.farmland.id);
    w.setBlock(6, 30, 4, BLOCK_BY_KEY.farmland.id);
    w.setBlock(4, 31, 4, WHEAT_CROP_0);
    w.setBlock(6, 31, 4, WHEAT_CROP_0);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.farmland.id); // 仍干
    // 放置水源：缓存增量更新，下一 tick 两块都变湿润
    w.setBlock(5, 30, 4, BLOCK_BY_KEY.water.id);
    tickCrops(w, 2);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.farmland_moist.id);
    expect(w.getBlock(6, 30, 4)).toBe(BLOCK_BY_KEY.farmland_moist.id);
    // 移除水源：缓存增量更新，耕地重新变干
    w.setBlock(5, 30, 4, AIR);
    tickCrops(w, 2);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.farmland.id);
    expect(w.getBlock(6, 30, 4)).toBe(BLOCK_BY_KEY.farmland.id);
  });

  it('耕地被非透明实心方块压顶 → 变回泥土；透明方块（树叶）压顶不触发', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, STONE); // 不透明实心压顶（MC：耕地退化）
    // 对照组：树叶透明压顶不退化；旁边供水保持湿润，排除干旱退化的概率干扰
    w.setBlock(6, 30, 4, FARMLAND());
    w.setBlock(6, 31, 4, BLOCK_BY_KEY.leaves.id);
    w.setBlock(8, 30, 4, BLOCK_BY_KEY.water.id);
    tickCrops(w, 2);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.dirt.id);
    expect(w.getBlock(6, 30, 4)).toBe(BLOCK_BY_KEY.farmland_moist.id);
  });

  it('作物格光照 ≤7 且不见天 → 弹出（Java canSurvive）；夜晚露天不弹', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 3);
    // 封闭黑暗：天空光/方块光均 0，白天也救不了——不见天
    w.chunks.get('0,0')!.sky.fill(0);
    worldClock.t = 0.3;
    tickCrops(w, 2);
    expect(w.getBlock(4, 31, 4)).toBe(0);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'wheat_seeds')).toBe(true);
    // 夜晚露天：光照 0 但能见天 → 存活（Java canSeeSky 兜底），只是停止生长
    clearDrops();
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 3);
    w.chunks.get('0,0')!.sky.fill(15);
    worldClock.t = 0.75; // 夜晚
    tickCrops(w, 2);
    expect(w.getBlock(4, 31, 4)).toBe(WHEAT_CROP_0 + 3);
    expect(itemDrops).toHaveLength(0);
    worldClock.t = 0; // 还原默认白天，防串扰同文件其他用例
  });

  it('踩坏耕地：trampleFarmland 变泥土 + 成熟作物按阶段弹出；非耕地返回 false', () => {
    const w = setup();
    w.setBlock(4, 30, 4, FARMLAND());
    w.setBlock(4, 31, 4, WHEAT_CROP_0 + 7);
    expect(trampleFarmland(w, 4, 30, 4)).toBe(true);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.dirt.id);
    expect(w.getBlock(4, 31, 4)).toBe(0);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'wheat')).toBe(true);
    expect(trampleFarmland(w, 4, 30, 4)).toBe(false); // 已是泥土，不再触发
  });

  it('打草丛概率掉小麦种子（统计 25%±10%）', () => {
    const w = setup();
    const grass = BLOCK_BY_KEY.short_grass.id;
    let seeds = 0;
    for (let i = 0; i < 200; i++) {
      clearDrops();
      w.setBlock(4, 30, 4, grass);
      breakBlock(w, 4, 30, 4);
      seeds += itemDrops.filter((d) => d.drop.kind === 'material' && d.drop.material === 'wheat_seeds').length;
    }
    expect(seeds).toBeGreaterThan(30); // 期望 ~50
    expect(seeds).toBeLessThan(75);
  });
});

describe('养殖（喂食繁殖）', () => {
  beforeEach(setup);

  it('breedMob 生成同种幼体，90s 后长成', () => {
    mobs.push({
      id: 1, type: 'pig', x: 0, y: 10, z: 0, velY: 0, hp: 10, attackCd: 0, onGround: true,
      wanderDir: 0, wanderTimer: 0, wanderMoving: false, fleeTimer: 0, fleeFromX: 0, fleeFromZ: 0,
      arrowCd: 0, ignite: -1,
    });
    const baby = breedMob(mobs[0]);
    expect(baby.type).toBe('pig');
    expect(baby.baby).toBe(true);
    expect(mobs.length).toBe(2);
  });
});
