// 爆炸机制（MC 1.20+ 对齐）：逐方块爆炸抗性（射线衰减/防爆特例免疫/圆石优于泥土）+ 伤害遮挡（隔墙免伤）

import { describe, expect, it, vi } from 'vitest';
import { AIR, BLOCK_BY_KEY, COBBLE, DIRT, STONE, WATER } from '../blocks';
import { explodeAt, explosionExposure } from '../explosion';
import { clearDrops } from '../items';
import { VOID_TERRAIN } from '../noise';
import { World } from '../world';

const FAR_PLAYER = { x: 100, y: 100, z: 100 };
const TNT_OPTS = { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true };

function newWorld(name: string): World {
  return new World(name, undefined, VOID_TERRAIN);
}

describe('逐方块爆炸抗性', () => {
  it('铁砧/附魔台/重生锚免疫 TNT（MC 抗性 1200，远高于硬度）', () => {
    const w = newWorld('exp-immune');
    // 附魔台/重生锚紧贴爆心；铁砧用于下方挡射线用例
    w.setBlock(5, 10, 4, BLOCK_BY_KEY.enchanting_table.id);
    w.setBlock(4, 10, 5, BLOCK_BY_KEY.respawn_anchor.id);
    explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    expect(w.getBlock(5, 10, 4)).toBe(BLOCK_BY_KEY.enchanting_table.id);
    expect(w.getBlock(4, 10, 5)).toBe(BLOCK_BY_KEY.respawn_anchor.id);
  });

  it('铁砧挡住爆炸射线：自身不毁且护住正后方泥土（MC：高抗性方块遮挡爆炸）', () => {
    const w = newWorld('exp-anvil-wall');
    w.setBlock(5, 10, 4, BLOCK_BY_KEY.anvil.id); // 爆心 (4,10,4) 与泥土 (6,10,4) 之间
    w.setBlock(6, 10, 4, DIRT);
    w.setBlock(4, 10, 5, DIRT); // 侧向泥土：无遮挡对照
    // 钉死随机数：侧向泥土 p = 1 - (1+0.5)/6 = 0.75，0.5 必碎；铁砧 p = 1 - (1+1200)/6 < 0 必不碎
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(5, 10, 4)).toBe(BLOCK_BY_KEY.anvil.id); // 铁砧免疫
    expect(w.getBlock(6, 10, 4)).toBe(DIRT); // 铁砧后方泥土被护住
    expect(w.getBlock(4, 10, 5)).toBe(AIR); // 无遮挡泥土被炸毁（对照）
  });

  it('黑曜石墙（防爆）吞掉整条射线，护住后方石头', () => {
    const w = newWorld('exp-obsidian-wall');
    w.setBlock(5, 10, 4, BLOCK_BY_KEY.obsidian.id);
    w.setBlock(6, 10, 4, STONE);
    explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    expect(w.getBlock(6, 10, 4)).toBe(STONE);
  });

  it('圆石比泥土抗爆（MC：抗性≈硬度，圆石 2 vs 泥土 0.5）——阈值确定性验证', () => {
    const w = newWorld('exp-cobble-vs-dirt');
    w.setBlock(5, 10, 4, COBBLE); // p = 1 - (1+2)/6 = 0.5
    w.setBlock(4, 10, 5, DIRT); // p = 1 - (1+0.5)/6 = 0.75
    // 随机数 0.6：泥土碎（0.6 < 0.75），圆石幸存（0.6 ≥ 0.5）
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    try {
      explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(5, 10, 4)).toBe(COBBLE);
    expect(w.getBlock(4, 10, 5)).toBe(AIR);
  });

  it('圆石墙挡 TNT 统计上明显好于泥土墙（幸存率 0.5 vs 0.25）', () => {
    const w = newWorld('exp-cobble-stat');
    clearDrops();
    let cobbleAlive = 0;
    let dirtAlive = 0;
    for (let i = 0; i < 200; i++) {
      w.setBlock(5, 10, 4, COBBLE);
      explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
      if (w.getBlock(5, 10, 4) === COBBLE) cobbleAlive++;
      w.setBlock(5, 10, 4, DIRT);
      explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
      if (w.getBlock(5, 10, 4) === DIRT) dirtAlive++;
    }
    // 期望 100 vs 50（标准差约 9），除非随机极度异常否则稳定成立
    expect(cobbleAlive).toBeGreaterThan(dirtAlive);
  });
});

describe('水吸收爆炸（Java：水/岩浆爆炸抗性 100）', () => {
  it('爆心在水下：周围石头全不碎（射线被水吞掉），水自身也免疫', () => {
    const w = newWorld('exp-underwater');
    w.setBlock(4, 10, 4, WATER); // 爆心格是水
    w.setBlock(5, 10, 4, STONE);
    w.setBlock(3, 10, 4, STONE);
    w.setBlock(4, 11, 4, STONE);
    w.setBlock(4, 9, 4, STONE);
    w.setBlock(4, 10, 5, STONE);
    w.setBlock(4, 10, 3, STONE);
    // 无需钉随机数：吸能 100 使破坏概率恒负
    explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    for (const [bx, by, bz] of [[5, 10, 4], [3, 10, 4], [4, 11, 4], [4, 9, 4], [4, 10, 5], [4, 10, 3]]) {
      expect(w.getBlock(bx, by, bz)).toBe(STONE);
    }
    expect(w.getBlock(4, 10, 4)).toBe(WATER); // 流体免疫爆炸的语义不变
  });

  it('爆心在空气中：水面下的方块按正常抗性结算（不被过度防护），水自身不毁', () => {
    const w = newWorld('exp-above-water');
    w.setBlock(4, 9, 4, WATER); // 爆心正下方一格是水面
    w.setBlock(4, 8, 4, STONE); // 水底的石头
    // 爆心在空气 → 无流体吸能；途经水格不衰减（旧语义）：石头 p = 1 - (2 + 0 + 1.5)/6 ≈ 0.417，0.4 必碎
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.4);
    try {
      explodeAt(w, 4.5, 10.5, 4.5, FAR_PLAYER, () => {}, TNT_OPTS);
    } finally {
      rand.mockRestore();
    }
    expect(w.getBlock(4, 8, 4)).toBe(AIR); // 水下方块正常被炸毁
    expect(w.getBlock(4, 9, 4)).toBe(WATER); // 流体免疫爆炸的语义不变
  });
});

describe('爆炸伤害遮挡（exposure）', () => {
  const PLAYER = { x: 3.5, y: 10, z: 0 };

  it('无遮挡：空旷地带正常吃满距离衰减伤害', () => {
    const w = newWorld('exp-open-dmg');
    let dmg = 0;
    explodeAt(w, 0, 10, 0, PLAYER, (d) => { dmg = d; }, TNT_OPTS);
    expect(dmg).toBeGreaterThan(10);
    expect(explosionExposure(w, 0, 10, 0, PLAYER)).toBe(1);
  });

  it('实心墙完全遮挡：隔墙免伤（修复前为隔墙满伤）', () => {
    const w = newWorld('exp-wall-dmg');
    // 黑曜石 3×3 墙（防爆，保证墙本身不被炸毁）：挡住爆心→玩家包围盒全部采样射线
    for (let y = 9; y <= 11; y++) for (let z = -1; z <= 1; z++) w.setBlock(1, y, z, BLOCK_BY_KEY.obsidian.id);
    let dmg = 0;
    explodeAt(w, 0, 10, 0, PLAYER, (d) => { dmg = d; }, TNT_OPTS);
    expect(explosionExposure(w, 0, 10, 0, PLAYER)).toBe(0);
    expect(dmg).toBe(0); // MC：exposure≈0 → 无伤害
  });

  it('半遮挡：伤害介于免伤与满伤之间（遮挡比例生效）', () => {
    const w = newWorld('exp-half-dmg');
    // 单格黑曜石只挡住偏 +z 一侧的射线（玩家包围盒 16 条采样射线约一半被挡）
    w.setBlock(1, 10, 0, BLOCK_BY_KEY.obsidian.id);
    const exposure = explosionExposure(w, 0, 10, 0, PLAYER);
    expect(exposure).toBeGreaterThan(0);
    expect(exposure).toBeLessThan(1);
    let dmgHalf = 0;
    explodeAt(w, 0, 10, 0, PLAYER, (d) => { dmgHalf = d; }, TNT_OPTS);
    let dmgOpen = 0;
    explodeAt(newWorld('exp-half-open'), 0, 10, 0, PLAYER, (d) => { dmgOpen = d; }, TNT_OPTS);
    expect(dmgHalf).toBeGreaterThan(0);
    expect(dmgHalf).toBeLessThan(dmgOpen);
  });
});
