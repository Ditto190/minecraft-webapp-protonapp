// 重锤（mace，Java 1.21）：smash 分段伤害、致密附魔、免摔伤契约、附魔台产出、结构战利品
// 物品本体定义在 lib/tools.ts（攻击/冷却/耐久）；本文件覆盖 Player 侧 smash 数值与战利品/附魔接线

import { beforeEach, describe, expect, it } from 'vitest';
import { survivalStats } from '../game';
import { hashString, SEA_LEVEL, type Terrain } from '../noise';
import { clearStorages, getStorage } from '../storage';
import { applyStronghold, STRONGHOLD_Y, strongholds } from '../stronghold';
import { applyStructures, buriedTreasureChest, fillChest, MACE_LOOT_CHANCE, structureAt, type StructureSpot } from '../structures';
import { tickSurvival, type SurvivalActions, type SurvivalEnv, type SurvivalMem, type SurvivalSnapshotLite } from '../survival';
import { CHUNK_SIZE, CHUNK_VOLUME } from '../grid';
import type { ToolType } from '../tools';
import { ENCHANTS, enchantsFor, MACE_SMASH_MIN_FALL, maceSmashBonus, rollOffers } from '../xp';

const MACE = 'mace' as ToolType; // tools.ts 的 mace 条目由并行任务添加

// ——— smash 分段伤害公式（Java：前 3 格 +4/格、4-8 格 +2/格、之后 +1/格；阈值 >1.5 格） ———
describe('重锤 smash 分段伤害（Java 1.21）', () => {
  it('阈值：下落 ≤1.5 格不触发（1.4 / 恰好 1.5 均为 0），超过即触发', () => {
    expect(MACE_SMASH_MIN_FALL).toBe(1.5);
    expect(maceSmashBonus(0)).toBe(0);
    expect(maceSmashBonus(1.4)).toBe(0);
    expect(maceSmashBonus(1.5)).toBe(0); // Java 是「超过 1.5」
    expect(maceSmashBonus(1.5001)).toBeGreaterThan(0);
  });

  it('分段加成逐项：2 格 +8 / 3 格 +12 / 4 格 +14 / 8 格 +22 / 9 格 +23 / 10 格 +24 / 12 格 +26', () => {
    expect(maceSmashBonus(2)).toBeCloseTo(8); // 前 3 档内：4/格
    expect(maceSmashBonus(3)).toBeCloseTo(12); // 3×4
    expect(maceSmashBonus(4)).toBeCloseTo(14); // 12 + 2
    expect(maceSmashBonus(8)).toBeCloseTo(22); // 12 + 5×2
    expect(maceSmashBonus(9)).toBeCloseTo(23); // 22 + 1
    expect(maceSmashBonus(10)).toBeCloseTo(24); // 22 + 2×1
    expect(maceSmashBonus(12)).toBeCloseTo(26); // 22 + 4×1
  });

  it('按实际下落距离浮点计（非取整）：2.5 格 = 2.5×4 = 10', () => {
    expect(maceSmashBonus(2.5)).toBeCloseTo(10);
    expect(maceSmashBonus(3.5)).toBeCloseTo(13); // 12 + 0.5×2
  });

  it('致密附魔：每级每格下落 +0.5（最高 V 级）；未触发 smash 时致密不生效', () => {
    expect(maceSmashBonus(5, 1)).toBeCloseTo(16 + 2.5); // 分段 16（12+2×2）+ 1×0.5×5
    expect(maceSmashBonus(5, 5)).toBeCloseTo(16 + 12.5); // 致密 V：+2.5/格
    expect(maceSmashBonus(10, 5)).toBeCloseTo(24 + 25); // 24 + 5×0.5×10
    expect(maceSmashBonus(1.4, 5)).toBe(0); // 未过阈值：致密一并无效（Java：致密加成只随 smash 结算）
    expect(maceSmashBonus(2, 0)).toBeCloseTo(8); // 0 级等同无附魔
  });
});

// ——— 免摔伤契约：smash 命中后 Player 侧重置 survivalMem.fallDist（本次落地不扣血） ———
describe('smash 免摔伤（重置摔落距离契约）', () => {
  let mem: SurvivalMem;
  let env: SurvivalEnv;
  let snap: SurvivalSnapshotLite;
  let dmg: number;
  let acts: SurvivalActions;

  beforeEach(() => {
    survivalStats.exhaustion = 0;
    survivalStats.wither = 0;
    mem = { fallDist: 0, air: 15, regenTick: 0, witherTick: 0, regenPotionTick: 0 };
    env = { dt: 0.05, flying: false, inWater: false, headInWater: false, onGround: false, velY: -10 };
    snap = { worldMode: 'survival', health: 20, hunger: 10, saturation: 0 };
    dmg = 0;
    acts = { damagePlayer: (n) => { dmg += n; }, setHealth: () => undefined, setHunger: () => undefined, setSaturation: () => undefined };
  });

  it('下落 10 格后 smash（fallDist 重置为 0）→ 落地不掉血；对照不重置则 floor(10-3)=7 伤', () => {
    // 空中累计下落距离（tickSurvival 规则：非飞行/非水/空中/velY<0）
    for (let i = 0; i < 20; i++) tickSurvival(env, mem, snap, acts);
    expect(mem.fallDist).toBeCloseTo(10);
    // smash 命中：Player.tsx 将 survivalMem.fallDist 重置为 0（MC：smash 免除本次摔落伤害）
    mem.fallDist = 0;
    env.onGround = true;
    env.velY = 0;
    tickSurvival(env, mem, snap, acts);
    expect(dmg).toBe(0);
    // 对照组：同样的 10 格下落不重置，落地按 MC 公式扣 7
    mem.fallDist = 0;
    env.onGround = false;
    env.velY = -10;
    for (let i = 0; i < 20; i++) tickSurvival(env, mem, snap, acts);
    env.onGround = true;
    env.velY = 0;
    tickSurvival(env, mem, snap, acts);
    expect(dmg).toBe(7);
  });
});

// ——— 致密附魔定义与附魔台产出 ———
describe('致密附魔（density，重锤专属）', () => {
  it('定义：最高 V 级、仅适用重锤、权重 5（少见，非宝藏——附魔台可出）', () => {
    expect(ENCHANTS.density).toMatchObject({ name: '致密', maxLvl: 5, applies: ['mace'], weight: 5 });
    // 耐久附魔对重锤同样适用（Java：重锤可附耐久）
    expect(ENCHANTS.unbreaking.applies).toContain('mace');
    expect(enchantsFor('mace').map((e) => e.key).sort()).toEqual(['density', 'unbreaking']);
  });

  it('附魔台能出致密：mace 类摇项含 density；其他物品类永不出 density', () => {
    let sawDensity = false;
    for (let seed = 0; seed < 60; seed++) {
      for (const o of rollOffers(seed, 'mace', 30, 15)) {
        for (const e of o.enchants) {
          expect(['density', 'unbreaking']).toContain(e.ench); // 重锤池只有致密/耐久
          if (e.ench === 'density') {
            sawDensity = true;
            expect(e.lvl).toBeGreaterThanOrEqual(1);
            expect(e.lvl).toBeLessThanOrEqual(5);
          }
        }
      }
    }
    expect(sawDensity).toBe(true);
    for (const kind of ['sword', 'dig', 'armor', 'hoe', 'bow'] as const) {
      for (let seed = 0; seed < 40; seed++) {
        expect(rollOffers(seed, kind, 30, 15).some((o) => o.enchants.some((e) => e.ench === 'density'))).toBe(false);
      }
    }
  });
});

// ——— 战利品（Java 重锤不可合成、试炼宝库限定；本项目简化为要塞/埋藏的宝藏箱低概率） ———
describe('重锤战利品（要塞/埋藏的宝藏，稀有）', () => {
  beforeEach(() => clearStorages());

  it('fillChest 工具战利品：chance 1 必出重锤工具槽、chance 0 不出；排在材料/方块战利品之后', () => {
    fillChest(123, 1, 2, 3, [['iron_ingot', 1, 1, 1]], undefined, [MACE, 1]);
    const loot = getStorage('1,2,3');
    expect(loot[0]).toMatchObject({ kind: 'material', material: 'iron_ingot' });
    expect(loot[1]?.kind).toBe('tool');
    if (loot[1]?.kind === 'tool') {
      expect(loot[1].tool).toBe('mace');
      expect(loot[1].durability).toBeGreaterThan(0); // 满耐久（TOOLS.mace 就位后取其耐久值）
    }
    clearStorages();
    fillChest(123, 4, 5, 6, [['iron_ingot', 1, 1, 1]], undefined, [MACE, 0]);
    expect(getStorage('4,5,6').some((s) => s?.kind === 'tool')).toBe(false);
  });

  it('概率克制：MACE_LOOT_CHANCE ≤ 0.1（别遍地都是）', () => {
    expect(MACE_LOOT_CHANCE).toBeGreaterThan(0);
    expect(MACE_LOOT_CHANCE).toBeLessThanOrEqual(0.1);
  });

  it('要塞宝箱可出重锤（确定性种子扫描：低概率但存在）', () => {
    let found = 0;
    for (let sh = 1; sh <= 120 && found === 0; sh++) {
      const s = strongholds(sh)[0];
      const ccx = Math.floor(s.x / CHUNK_SIZE);
      const ccz = Math.floor(s.z / CHUNK_SIZE);
      applyStronghold(sh, ccx, ccz, new Uint16Array(CHUNK_VOLUME));
      const loot = getStorage(`${s.x + 3},${STRONGHOLD_Y + 1},${s.z - 3}`);
      if (loot.some((slot) => slot?.kind === 'tool' && (slot.tool as string) === 'mace')) found = sh;
    }
    expect(found).toBeGreaterThan(0); // 120 座要塞（5% 期望 6 座）一座都没有说明战利品没接上
  });

  it('埋藏的宝藏箱可出重锤（确定性种子扫描：低概率但存在）', () => {
    // 海岸线 x=40：西侧滩涂、东侧海（与 treasure.test.ts 同款 mock；区域中心仅 rx=0 列落在海岸带）
    const COAST: Terrain = {
      heightAt: (x) => (x < 40 ? SEA_LEVEL + 1 : SEA_LEVEL - 8),
      biomeAt: () => 'plains',
      treeAt: () => null,
      caveAt: () => false,
      snowlineAt: () => Infinity,
      undergroundAt: () => null,
      aquiferAt: () => false,
    };
    let found = 0;
    for (let i = 0; i < 300 && found === 0; i++) {
      const sh = hashString(`mace-treasure-${i}`);
      let spot: StructureSpot | null = null;
      for (let rz = -30; rz < 60 && !spot; rz++) {
        const s = structureAt(sh, COAST, 0, rz);
        if (s?.kind === 'buried_treasure') spot = s;
      }
      if (!spot) continue;
      const c = buriedTreasureChest(sh, COAST, spot);
      const data = new Uint16Array(CHUNK_VOLUME);
      applyStructures(sh, COAST, Math.floor(c.x / CHUNK_SIZE), Math.floor(c.z / CHUNK_SIZE), data);
      const loot = getStorage(`${c.x},${c.y},${c.z}`);
      if (loot.some((slot) => slot?.kind === 'tool' && (slot.tool as string) === 'mace')) found = i + 1;
    }
    expect(found).toBeGreaterThan(0); // 300 个宝藏（5% 期望 15 个）一个都没有说明战利品没接上
  });
});
