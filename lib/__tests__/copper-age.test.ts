// 1.21.9 铜制工具/盔甲 + 1.21 重锤：物品定义数值（wiki 校准）、挖掘速度与采掘层级、
// 护甲减伤、合成配方、修复材料映射、canvas 图标格

import { describe, expect, it } from 'vitest';
import { armorDef, armorPoints, damageAfterArmor, emptyArmorSlots } from '../armor';
import { armorRepairMaterial, toolRepairMaterial } from '../anvil';
import { ATLAS_COLS, ATLAS_ROWS, BLOCK_BY_KEY, ICON_TILE_START, TILE_STEMS } from '../blocks';
import { effectiveDigTime } from '../dig';
import { applyCraft, canCraft, RECIPES, recipePattern } from '../recipes';
import { addStackToSlots, emptySlots, type Slot } from '../slots';
import { TEXTURE_OVERLAYS } from '../textures';
import { TOOLS } from '../tools';

const K = (k: string) => BLOCK_BY_KEY[k].id;
const COPPER_TOOLS = ['copper_pickaxe', 'copper_axe', 'copper_shovel', 'copper_sword', 'copper_hoe'] as const;
const tool = (t: (typeof COPPER_TOOLS)[number] | 'mace'): Slot => ({ kind: 'tool', tool: t, durability: 500 });

describe('铜工具数值（MC 1.21.9 Copper Age）', () => {
  it('五件注册：耐久 190（石 131/铁 250 之间）、采掘层级同石（tier 字段驱动 pickTier 比较）', () => {
    for (const t of COPPER_TOOLS) {
      expect(TOOLS[t], t).toBeDefined();
      expect(TOOLS[t].durability, t).toBe(190);
      expect(TOOLS[t].tier, t).toBe('stone');
    }
  });

  it('挖掘速度 5（石 4/铁 6 之间；剑恒 1 不加速）', () => {
    expect(TOOLS.copper_pickaxe.speed).toBe(5);
    expect(TOOLS.copper_axe.speed).toBe(5);
    expect(TOOLS.copper_shovel.speed).toBe(5);
    expect(TOOLS.copper_hoe.speed).toBe(5);
    expect(TOOLS.copper_sword.speed).toBe(1);
    expect(TOOLS.copper_pickaxe.speed).toBeGreaterThan(TOOLS.stone_pickaxe.speed);
    expect(TOOLS.copper_pickaxe.speed).toBeLessThan(TOOLS.iron_pickaxe.speed);
  });

  it('攻击伤害同石（官方更新日志 same damage as stone）：镐 3、斧 9、锹 3、剑 5、锄 1', () => {
    expect(TOOLS.copper_pickaxe.attackDamage).toBe(TOOLS.stone_pickaxe.attackDamage); // 3
    expect(TOOLS.copper_axe.attackDamage).toBe(TOOLS.stone_axe.attackDamage); // 9
    expect(TOOLS.copper_shovel.attackDamage).toBe(TOOLS.stone_shovel.attackDamage); // 3（Java 3.5，项目取整惯例）
    expect(TOOLS.copper_sword.attackDamage).toBe(TOOLS.stone_sword.attackDamage); // 5
    expect(TOOLS.copper_hoe.attackDamage).toBe(1);
  });

  it('攻速同石：镐 1.2、斧 0.8、锹 1.0、剑 1.6、锄 2（冷却 = 1/攻速）', () => {
    expect(TOOLS.copper_pickaxe.attackCd).toBeCloseTo(1 / 1.2, 6);
    expect(TOOLS.copper_axe.attackCd).toBeCloseTo(1 / 0.8, 6);
    expect(TOOLS.copper_shovel.attackCd).toBe(1);
    expect(TOOLS.copper_sword.attackCd).toBeCloseTo(1 / 1.6, 6);
    expect(TOOLS.copper_hoe.attackCd).toBeCloseTo(1 / 2, 6);
  });
});

describe('铜镐挖掘（速度 5、层级同石）', () => {
  it('石头（任意镐可采）：7.5×0.3/5 = 0.45s，比石镐（×0.3/4 ≈ 0.5625s）快', () => {
    const stonePick: Slot = { kind: 'tool', tool: 'stone_pickaxe', durability: 131 };
    expect(effectiveDigTime(K('stone'), tool('copper_pickaxe'), false)).toBeCloseTo(0.45, 6);
    expect(effectiveDigTime(K('stone'), tool('copper_pickaxe'), false)).toBeLessThan(
      effectiveDigTime(K('stone'), stonePick, false),
    );
  });

  it('铁矿石（pickTier 1 需石镐）：达标可采 15×0.3/5 = 0.9s', () => {
    expect(effectiveDigTime(K('iron_ore'), tool('copper_pickaxe'), false)).toBeCloseTo(0.9, 6);
  });

  it('钻石矿（pickTier 2 需铁镐）：层级不足 15/5 = 3s（Java：快但挖完不掉落，门禁在 actions.ts）', () => {
    expect(effectiveDigTime(K('diamond_ore'), tool('copper_pickaxe'), false)).toBe(3);
  });

  it('黑曜石（pickTier 3 需钻镐）：不可采 250/5 = 50s', () => {
    expect(effectiveDigTime(K('obsidian'), tool('copper_pickaxe'), false)).toBe(50);
  });
});

describe('铜盔甲（MC 1.21.9：2/4/3/1 共 10 点，耐久倍率 11 高于金 7 低于铁 15）', () => {
  it('逐件点数与耐久：头 2/121、胸 4/176、腿 3/165、靴 1/143，韧性 0，名随材质', () => {
    expect(armorDef('copper', 'helmet')).toMatchObject({ points: 2, durability: 121, toughness: 0, name: '铜头盔' });
    expect(armorDef('copper', 'chestplate')).toMatchObject({ points: 4, durability: 176, toughness: 0, name: '铜胸甲' });
    expect(armorDef('copper', 'leggings')).toMatchObject({ points: 3, durability: 165, toughness: 0, name: '铜护腿' });
    expect(armorDef('copper', 'boots')).toMatchObject({ points: 1, durability: 143, toughness: 0, name: '铜靴子' });
  });

  it('全套 10 点（皮革 7 与金 11 之间）；吃 10 伤害减到 8（max(10/5, 10-10/2)/25 = 20%）', () => {
    const slots = emptyArmorSlots();
    for (const p of ['helmet', 'chestplate', 'leggings', 'boots'] as const) slots[p] = { durability: 1, material: 'copper' };
    expect(armorPoints(slots)).toBe(10);
    expect(damageAfterArmor(10, slots)).toBeCloseTo(8, 6);
  });

  it('修复材料：铜工具/铜甲均为铜锭（工具 tier 记 stone 采掘层级，修复须按工具名识别）', () => {
    for (const t of COPPER_TOOLS) expect(toolRepairMaterial(t), t).toBe('material:copper_ingot');
    expect(armorRepairMaterial('copper')).toBe('material:copper_ingot');
  });
});

describe('铜配方（铜锭 + 木棍，同型布局需工作台）', () => {
  it('5 件工具配方：铜锭 3/3/1/2/2 + 木棍 2/2/2/1/2', () => {
    const costs: Record<(typeof COPPER_TOOLS)[number], [number, number]> = {
      copper_pickaxe: [3, 2],
      copper_axe: [3, 2],
      copper_shovel: [1, 2],
      copper_sword: [2, 1],
      copper_hoe: [2, 2],
    };
    for (const t of COPPER_TOOLS) {
      const r = RECIPES.find((x) => x.id === t);
      expect(r, t).toBeDefined();
      expect(r!.out).toEqual({ kind: 'tool', tool: t });
      expect(r!.needsTable).toBe(true);
      expect(r!.cost).toEqual([
        { item: 'material:copper_ingot', count: costs[t][0] },
        { item: 'material:stick', count: costs[t][1] },
      ]);
    }
  });

  it('4 件盔甲配方：铜锭 5/8/7/4（MC 同型用量）', () => {
    const cost: Record<string, number> = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };
    for (const [piece, n] of Object.entries(cost)) {
      const r = RECIPES.find((x) => x.id === `copper_${piece}`);
      expect(r, piece).toBeDefined();
      expect(r!.out).toEqual({ kind: 'armor', piece, material: 'copper' });
      expect(r!.cost).toEqual([{ item: 'material:copper_ingot', count: n }]);
      expect(r!.needsTable).toBe(true);
    }
  });

  it('铜镐 MC 摆法（3 铜锭横排 + 竖 2 木棍）；实际合成得 190 耐久铜镐', () => {
    const r = RECIPES.find((x) => x.id === 'copper_pickaxe')!;
    expect(recipePattern(r)).toEqual([
      'material:copper_ingot', 'material:copper_ingot', 'material:copper_ingot',
      null, 'material:stick', null,
      null, 'material:stick', null,
    ]);
    let slots = emptySlots();
    slots = addStackToSlots(slots, { kind: 'material', material: 'copper_ingot' }, 3).slots;
    slots = addStackToSlots(slots, { kind: 'material', material: 'stick' }, 2).slots;
    expect(canCraft(slots, r)).toBe(true);
    slots = applyCraft(slots, r, TOOLS.copper_pickaxe.durability);
    expect(slots.some((s) => s?.kind === 'tool' && s.tool === 'copper_pickaxe' && s.durability === 190)).toBe(true);
    expect(canCraft(slots, r)).toBe(false); // 材料已耗尽
  });
});

describe('重锤 mace（MC 1.21 物品定义；smash 实战机制/附魔/获取另见 xp.ts/Player.tsx/structures.ts）', () => {
  it('定义：新 kind mace、伤害 5、攻速 0.6（冷却 ~1.67s）、耐久 500（1.21 正式版值）', () => {
    expect(TOOLS.mace.kind).toBe('mace');
    expect(TOOLS.mace.attackDamage).toBe(5);
    expect(TOOLS.mace.attackCd).toBeCloseTo(1 / 0.6); // Java：攻速 0.6（全游戏最慢）
    expect(TOOLS.mace.durability).toBe(500);
    expect(TOOLS.mace.name).toBe('重锤');
  });

  it('不可合成（本项目无试炼大厅材料——沉重核心/旋风棒，战利品限定）', () => {
    expect(RECIPES.some((r) => r.out.kind === 'tool' && r.out.tool === 'mace')).toBe(false);
  });

  it('不可材料修复（MC 用旋风棒，项目无此材料）；挖掘不加速（kind 不匹配任何方块 tool）', () => {
    expect(toolRepairMaterial('mace')).toBeNull();
    expect(effectiveDigTime(K('stone'), tool('mace'), false)).toBe(7.5);
  });
});

describe('canvas 图标格（贴图包无 1.21.9/1.21 新贴图，全部自绘）', () => {
  it('7 格互不冲突且在 atlas 容量内；铜斧/锹/剑与铜镐共用（项目惯例：同 tier 复用镐形贴图）', () => {
    const cells = [
      TOOLS.copper_pickaxe.iconTile,
      TOOLS.copper_hoe.iconTile,
      TOOLS.mace.iconTile,
      armorDef('copper', 'helmet').iconTile,
      armorDef('copper', 'chestplate').iconTile,
      armorDef('copper', 'leggings').iconTile,
      armorDef('copper', 'boots').iconTile,
    ];
    expect(new Set(cells).size).toBe(7);
    for (const c of cells) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(ATLAS_ROWS * ATLAS_COLS);
    }
    expect(TOOLS.copper_axe.iconTile).toBe(TOOLS.copper_pickaxe.iconTile);
    expect(TOOLS.copper_shovel.iconTile).toBe(TOOLS.copper_pickaxe.iconTile);
    expect(TOOLS.copper_sword.iconTile).toBe(TOOLS.copper_pickaxe.iconTile);
    // 铜镐格在 ICON_TILE_START 后的图标区末格（+25..+30 已被 1.21.5 植物占用，+31 为 atlas 容量内最后一格）
    expect(TOOLS.copper_pickaxe.iconTile).toBe(ICON_TILE_START + 31);
  });

  it('每个图标格在 TEXTURE_OVERLAYS 都有对应绘制函数（tools/armor 引用与绘制表不错位）', () => {
    const cells = new Set(Object.keys(TEXTURE_OVERLAYS).map(Number));
    const refs = [
      TOOLS.copper_pickaxe.iconTile,
      TOOLS.copper_axe.iconTile,
      TOOLS.copper_shovel.iconTile,
      TOOLS.copper_sword.iconTile,
      TOOLS.copper_hoe.iconTile,
      TOOLS.mace.iconTile,
      armorDef('copper', 'helmet').iconTile,
      armorDef('copper', 'chestplate').iconTile,
      armorDef('copper', 'leggings').iconTile,
      armorDef('copper', 'boots').iconTile,
    ];
    for (const c of refs) expect(cells.has(c), `格 ${c} 缺绘制`).toBe(true);
  });

  it('护栏：pack 预留区借用格（506..511）不得被新贴图 stem 占用——新增 stem 触线须先迁移这些图标', () => {
    expect(TILE_STEMS.length).toBeLessThanOrEqual(506);
  });
});
