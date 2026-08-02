// TNT：引信计时爆炸 / 防爆规则 / 共享爆炸逻辑 / 打火石点燃 / 爆炸掉落

import { describe, expect, it, vi } from 'vitest';
import { Vector3, type Camera } from 'three';
import { tryPlace } from '../actions';
import { AIR, BLOCK_BY_KEY, STONE } from '../blocks';
import { explodeAt } from '../explosion';
import { cameraRef, setActiveWorld } from '../game';
import { clearDrops, itemDrops } from '../items';
import { clearMobs } from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { useGameStore } from '../store';
import { emptySlots } from '../slots';
import { igniteTnt, primedTnt, tickTnt, clearTnt } from '../tnt';
import { World } from '../world';

const P = { x: 0, y: 0, z: 0 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TNT 与爆炸', () => {
  it('引信到 0 才爆炸，之前不炸', () => {
    const w = new World('tnt-fuse', undefined, VOID_TERRAIN);
    igniteTnt(4, 30, 4);
    expect(primedTnt[0].fuse).toBe(4); // 默认引信 4s（打火石/红石路径，MC 80 tick）
    tickTnt(w, 1, P, () => {});
    tickTnt(w, 2, P, () => {});
    expect(primedTnt.length).toBe(1);
    tickTnt(w, 1.1, P, () => {});
    expect(primedTnt.length).toBe(0);
  });

  it('爆炸波及 TNT：连锁引信为随机 10-29 tick（0.5-1.45s），短于打火石 4s（MC）', () => {
    clearTnt();
    const w = new World('tnt-chain', undefined, VOID_TERRAIN);
    w.setBlock(4, 4, 4, BLOCK_BY_KEY.tnt.id);
    // 钉死随机数：爆心 TNT 破坏概率 ≈ 1 - 0.03/6 ≈ 0.99，0.5 必中；连锁引信 = 0.5 + 0.5×0.95 = 0.975s（在 10-29 tick 区间内）
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true });
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 4, 4)).toBe(AIR); // 原方块转为点燃实体
    expect(primedTnt.length).toBe(1);
    expect(primedTnt[0].fuse).toBeGreaterThanOrEqual(0.5);
    expect(primedTnt[0].fuse).toBeLessThanOrEqual(1.45);
    clearTnt();
  });

  it('爆炸破坏石头但不破坏黑曜石与基岩', () => {
    const w = new World('tnt-blast', undefined, VOID_TERRAIN);
    w.setBlock(4, 4, 4, STONE);
    w.setBlock(5, 4, 4, BLOCK_BY_KEY.obsidian.id);
    w.setBlock(6, 4, 4, BLOCK_BY_KEY.bedrock.id);
    // 钉死随机数：爆心石头破坏概率 = 1 - (0 + 自身硬度 1.5)/6 = 0.75（MC 逐方块抗性），0.5 < 0.75 必碎
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 4, maxDamage: 32, hurtRadius: 7 });
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 4, 4)).toBe(AIR);
    expect(w.getBlock(5, 4, 4)).toBe(BLOCK_BY_KEY.obsidian.id);
    expect(w.getBlock(6, 4, 4)).toBe(BLOCK_BY_KEY.bedrock.id);
  });

  it('伤害随距离衰减，半径外无伤', () => {
    const w = new World('tnt-dmg', undefined, VOID_TERRAIN);
    let near = 0;
    explodeAt(w, 0, 10, 0, { x: 1.5, y: 10, z: 0 }, (d) => { near = d; }, { radius: 4, maxDamage: 32, hurtRadius: 7 });
    expect(near).toBeGreaterThan(15);
    let far = 0;
    explodeAt(w, 0, 10, 0, { x: 20, y: 10, z: 0 }, (d) => { far = d; }, { radius: 4, maxDamage: 32, hurtRadius: 7 });
    expect(far).toBe(0);
  });

  it('爆炸冲击波把近爆心的已点燃 TNT 实体弹开（MC knockback）', () => {
    clearTnt();
    const w = new World('tnt-knockback', undefined, VOID_TERRAIN);
    igniteTnt(6, 4, 4); // 实体位于 (6.5, 4.02, 4.5)，爆心 +x 方向 2 格
    const t = primedTnt[0];
    const x0 = t.x;
    const z0 = t.z;
    explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true });
    expect(t.vx).toBeGreaterThan(0); // 沿爆心向外（+x）获得冲量
    tickTnt(w, 0.05, P, () => {});
    tickTnt(w, 0.05, P, () => {});
    expect(Math.hypot(t.x - x0, t.z - z0)).toBeGreaterThan(0.1); // 被推出原位
    expect(t.x).toBeGreaterThan(x0); // 远离爆心方向
    clearTnt();
  });

  it('击退的 TNT 撞实心方块即停（不穿透）', () => {
    clearTnt();
    const w = new World('tnt-knockback-wall', undefined, VOID_TERRAIN);
    for (let y = 2; y <= 5; y++) w.setBlock(8, y, 4, BLOCK_BY_KEY.obsidian.id); // 防爆墙（实体下落换行也仍被挡）
    igniteTnt(6, 4, 4); // 实体 (6.5, 4.02, 4.5)，墙面在 x=8（实体半宽 0.49 → x≥7.51 受阻）
    const t = primedTnt[0];
    explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true });
    for (let i = 0; i < 20; i++) tickTnt(w, 0.05, P, () => {});
    expect(t.x).toBeLessThan(7.51); // 停在墙前，没穿进 x=8 格
    expect(t.vx).toBe(0); // 撞墙后水平速度清零
    clearTnt();
  });
});

describe('爆炸掉落', () => {
  it('TNT 爆炸 100% 掉落被破坏方块（MC 1.14+）；防爆方块不掉', () => {
    const w = new World('tnt-drop', undefined, VOID_TERRAIN);
    clearDrops();
    w.setBlock(4, 4, 4, STONE);
    w.setBlock(4, 5, 4, BLOCK_BY_KEY.obsidian.id);
    // 钉死随机数：破坏判定 0.5 < 1 - 1.5/6 = 0.75 必中（爆心石头计入自身硬度 1.5 抗性）；掉落判定 0.5 < 1（TNT）必中
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true });
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 4, 4)).toBe(AIR);
    expect(itemDrops.length).toBe(1);
    expect(itemDrops[0].drop).toEqual({ kind: 'block', blockId: BLOCK_BY_KEY.cobble.id }); // MC：石头掉圆石
    expect(w.getBlock(4, 5, 4)).toBe(BLOCK_BY_KEY.obsidian.id); // 防爆方块不破坏不掉落
  });

  it('非 TNT 爆炸（苦力怕）按 1/威力概率掉落（MC）', () => {
    const w = new World('creeper-drop', undefined, VOID_TERRAIN);
    clearDrops();
    w.setBlock(4, 4, 4, STONE);
    // 破坏判定 0.5 < 1 - 1.5/5 = 0.7 必中（爆心石头计入自身硬度 1.5 抗性）；掉落判定 0.5 ≥ 1/3 不中
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      explodeAt(w, 4.5, 4.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, { radius: 3, maxDamage: 22, hurtRadius: 4.5 });
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 4, 4)).toBe(AIR); // 方块仍被炸毁
    expect(itemDrops.length).toBe(0); // 但按概率不掉落
  });
});

describe('打火石点燃', () => {
  function setup(): World {
    clearTnt();
    clearDrops();
    clearMobs();
    const w = new World('tnt-ignite', undefined, VOID_TERRAIN);
    setActiveWorld(w);
    useGameStore.getState().loadSurvival({ health: 20, hunger: 20, slots: emptySlots() });
    useGameStore.setState({ worldMode: 'survival', notice: null });
    cameraRef.current = {
      position: new Vector3(4.5, 32, 4.5),
      getWorldDirection: (v: Vector3) => v.set(0, -1, 0).normalize(),
    } as unknown as Camera;
    return w;
  }

  it('空手右键 TNT 不点燃（MC：需打火石/火焰弹或红石信号）', async () => {
    const w = setup();
    w.setBlock(4, 30, 4, BLOCK_BY_KEY.tnt.id);
    useGameStore.setState({ selectedSlot: 0 }); // 空手
    await wait(160); // 放置冷却（用例隔离）
    expect(tryPlace()).toBe(false);
    expect(w.getBlock(4, 30, 4)).toBe(BLOCK_BY_KEY.tnt.id);
    expect(primedTnt.length).toBe(0);
  });

  it('手持打火石右键 TNT：方块消失，生成引信实体', async () => {
    const w = setup();
    w.setBlock(4, 30, 4, BLOCK_BY_KEY.tnt.id);
    useGameStore.getState().addStack({ kind: 'material', material: 'flint_and_steel' }, 1);
    useGameStore.setState({ selectedSlot: 0 });
    await wait(160);
    expect(tryPlace()).toBe(true);
    expect(w.getBlock(4, 30, 4)).toBe(AIR);
    expect(primedTnt.length).toBe(1);
  });
});
