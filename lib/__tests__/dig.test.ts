// 挖掘时间：digTime 表为 MC 徒手时间（需镐方块 = 硬度×5，徒手可采 = 硬度×1.5）。
// Java：destroySpeed 只看工具类别匹配（与采掘层级无关），层级不足只影响掉落——需镐方块层级不足
// 保持 ×5 基值但仍除工具速度（木镐钻石矿 15/2=7.5s）；达标切 ×1.5 基值（×0.3）；
// 效率附魔速度>1 时 +等级²+1；剪刀特判树叶/藤蔓 15x、羊毛 5x；急迫 +20%/级；水中/悬空各 ×5 慢

import { describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY } from '../blocks';
import { effectiveDigTime } from '../dig';
import type { Slot } from '../slots';
import type { ToolType } from '../tools';
import type { EnchMap } from '../xp';

const K = (k: string) => BLOCK_BY_KEY[k].id;
const tool = (t: ToolType, ench?: EnchMap): Slot => ({ kind: 'tool', tool: t, durability: 100, ench });

describe('有效挖掘时间（MC 基值）', () => {
  it('需镐方块：工具匹配按 hardness×1.5/工具速度（digTime×0.3/speed）', () => {
    // 黑曜石 250（硬度 50×5）：钻镐 250×0.3/8 = 9.375s（MC 9.4s）
    expect(effectiveDigTime(K('obsidian'), tool('diamond_pickaxe'), false)).toBeCloseTo(9.375, 3);
    // 石头 7.5（硬度 1.5×5）：木镐 7.5×0.3/2 = 1.125s（MC 1.13s）
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('wooden_pickaxe'), false)).toBeCloseTo(1.125, 3);
    // 远古残骸 150（硬度 30×5）：钻镐 5.625s（MC 一致）
    expect(effectiveDigTime(K('ancient_debris'), tool('diamond_pickaxe'), false)).toBeCloseTo(5.625, 3);
    // 煤矿石 15（硬度 3×5）：木镐 2.25s
    expect(effectiveDigTime(K('coal_ore'), tool('wooden_pickaxe'), false)).toBeCloseTo(2.25, 3);
  });

  it('徒手/错工具：保持 digTime（需镐方块 = 硬度×5 慢速）', () => {
    expect(effectiveDigTime(K('obsidian'), null, false)).toBe(250);
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, null, false)).toBe(7.5);
    // 斧挖石头类型不匹配：不加速
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('diamond_axe'), false)).toBe(7.5);
    // 剑不是挖掘工具：挖泥土也不加速
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('diamond_sword'), false)).toBe(0.75);
  });

  it('采掘层级不足：保持 ×5 慢速基值但仍除工具速度（Java：层级只影响掉落，门禁在 actions.ts）', () => {
    // 钻石矿 pickTier 2（需铁镐）：木镐（tier 0）15/2 = 7.5s——挖得动但挖完不掉落（旧版 15s 是偏差）
    expect(effectiveDigTime(K('diamond_ore'), tool('wooden_pickaxe'), false)).toBe(7.5);
    // 金镐（层级同木、速度 12）：15/12 = 1.25s——快但同样不掉落
    expect(effectiveDigTime(K('diamond_ore'), tool('golden_pickaxe'), false)).toBe(1.25);
    // 铁镐（tier 2）达标：15×0.3/6 = 0.75s
    expect(effectiveDigTime(K('diamond_ore'), tool('iron_pickaxe'), false)).toBeCloseTo(0.75, 3);
    // 黑曜石 pickTier 3（需钻镐）：铁镐 250/6 ≈ 41.7s（旧版 250s 是偏差）
    expect(effectiveDigTime(K('obsidian'), tool('iron_pickaxe'), false)).toBeCloseTo(250 / 6, 3);
    // 铁矿 pickTier 1（需石镐）：石镐达标 15×0.3/4 = 1.125s
    expect(effectiveDigTime(K('iron_ore'), tool('stone_pickaxe'), false)).toBeCloseTo(1.125, 3);
    // needsPick 无 pickTier（石头 = 任意镐）：木镐仍匹配（上面用例 1.125s 已覆盖）
  });

  it('徒手可采方块（×1.5 基值）：工具匹配直接除速度，不再乘 0.3', () => {
    // 泥土 0.75（硬度 0.5×1.5）：木锹 0.375s（MC 一致）
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('wooden_shovel'), false)).toBeCloseTo(0.375, 3);
    // 原木 3（硬度 2×1.5）：钻斧 0.375s
    expect(effectiveDigTime(K('log'), tool('diamond_axe'), false)).toBeCloseTo(0.375, 3);
  });

  it('效率附魔仅工具类别匹配时生效（MC Java：速度>1 时 + 等级²+1，效率 V 钻镐 8→34）', () => {
    // 钻镐效率 V 挖石头：7.5×0.3/(8+(5²+1)) = 2.25/34
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('diamond_pickaxe', { efficiency: 5 }), false)).toBeCloseTo(2.25 / 34, 4);
    // 错工具带效率：不加速（MC 不允许）
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('diamond_axe', { efficiency: 5 }), false)).toBe(7.5);
    // 层级不足但类别匹配：效率同样生效（Java 速度>1 即加）——木镐效率 V 挖钻石矿 15/(2+26)
    expect(effectiveDigTime(K('diamond_ore'), tool('wooden_pickaxe', { efficiency: 5 }), false)).toBeCloseTo(15 / 28, 4);
  });

  it('剪刀/锄特判（Java：ShearsItem 硬编码倍率与层级无关；HoeItem 按层级加速树叶/干草捆/海绵/苔藓）', () => {
    // 剪刀：树叶/藤蔓 15x
    expect(effectiveDigTime(K('leaves'), tool('shears'), false)).toBeCloseTo(0.35 / 15, 4);
    expect(effectiveDigTime(K('vine_n'), tool('shears'), false)).toBeCloseTo(0.05 / 15, 4);
    // 剪刀：羊毛类 5x
    expect(effectiveDigTime(K('white_wool'), tool('shears'), false)).toBeCloseTo(1.2 / 5, 3);
    // 剪刀对泥土无加成
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('shears'), false)).toBe(0.75);
    // 锄按层级 2/4/6/8 加速：树叶木锄 0.35/2、钻锄 0.35/8；干草捆/海绵/苔藓同规则
    expect(effectiveDigTime(K('leaves'), tool('wooden_hoe'), false)).toBeCloseTo(0.35 / 2, 4);
    expect(effectiveDigTime(K('leaves'), tool('diamond_hoe'), false)).toBeCloseTo(0.35 / 8, 4);
    expect(effectiveDigTime(K('hay_block'), tool('iron_hoe'), false)).toBeCloseTo(0.75 / 6, 4);
    expect(effectiveDigTime(K('sponge'), tool('stone_hoe'), false)).toBeCloseTo(0.9 / 4, 4);
    expect(effectiveDigTime(K('moss_block'), tool('wooden_hoe'), false)).toBeCloseTo(0.2 / 2, 4);
  });

  it('急迫：匹配与不匹配都 +20%/级（MC Java）', () => {
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('wooden_pickaxe'), true)).toBeCloseTo(1.125 / 1.2, 4);
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, null, true)).toBeCloseTo(0.75 / 1.2, 4);
    // 急迫 II：+40%
    expect(effectiveDigTime(BLOCK_BY_KEY.stone.id, tool('wooden_pickaxe'), 2)).toBeCloseTo(1.125 / 1.4, 4);
  });

  it('悬空挖掘（脚不沾地）×5 慢（MC Java），与水中惩罚叠乘', () => {
    // 木锹挖泥土：着地 0.375s → 悬空 1.875s
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('wooden_shovel'), false, false, false)).toBeCloseTo(1.875, 3);
    // 悬空 + 头入水：×25
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('wooden_shovel'), false, true, false)).toBeCloseTo(9.375, 3);
    // 默认参数 = 着地（旧调用签名行为不变）
    expect(effectiveDigTime(BLOCK_BY_KEY.dirt.id, tool('wooden_shovel'), false)).toBeCloseTo(0.375, 3);
  });
});
