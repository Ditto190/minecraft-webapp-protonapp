// 挖掘时间换算：blocks.ts 的 digTime 表存 MC 徒手时间（需镐方块 = 硬度×5，徒手可采 = 硬度×1.5）。
// Java 公式：进度 = destroySpeed / 硬度 / (可采掘 ? 30 : 100)——destroySpeed 只看工具类别是否匹配方块（与采掘层级无关），
// 层级不足只影响掉落（门禁在 actions.ts）不影响挖掘速度。纯逻辑可单测

import { BLOCKS, type BlockId } from './blocks';
import type { Slot } from './slots';
import { TOOLS, type ToolTier } from './tools';

/** MC 采掘层级排序（与 actions.ts 掉落判定一致）：木 0 石 1 铁 2 钻 3 合金 4 */
const TIER_ORDER: ToolTier[] = ['wood', 'stone', 'iron', 'diamond', 'netherite'];

/** 剪刀硬编码挖掘倍率（Java ShearsItem，与采掘层级无关）：树叶/藤蔓 15x、羊毛类 5x，其余 1x */
function shearSpeed(key: string | undefined): number {
  if (!key) return 1;
  if (key === 'leaves' || key.endsWith('_leaves') || key.startsWith('vine_')) return 15;
  if (key.endsWith('_wool')) return 5;
  return 1;
}

/**
 * 有效挖掘时长（秒，MC Java）：
 * - 工具类别匹配方块 tool（剑除外）：按工具速度加速，与采掘层级无关（木镐挖钻石矿 15/2 = 7.5s）。
 *   需镐方块（needsPick/pickTier，digTime 为硬度×5）层级达标时切 ×1.5 基值（digTime×0.3）再除速度；
 *   层级不足保持 ×5 基值但仍除速度（铁镐挖黑曜石 250/6 ≈ 41.7s），挖完不掉落（掉落门禁在 actions.ts）
 * - 效率附魔：速度 > 1（类别匹配）时 + (等级²+1)，层级不足同样生效（MC Java；效率 V 钻镐 8→34）
 * - 剪刀特判（Java ShearsItem 硬编码倍率，与层级无关）：树叶/藤蔓 15x、羊毛类 5x
 * - 徒手或工具类别不匹配：原 digTime（需镐方块即 MC 的 hardness×5 慢速惩罚）
 * - 急迫效果：每级 +20%（MC Java；信标 4 层 II 级 +40%）
 * - 头在水中 ×5 慢；脚不沾地（悬空/飞行挖掘）再 ×5 慢（MC Java 规则）
 */
export function effectiveDigTime(blockId: BlockId, held: Slot, haste: boolean | number, underwater = false, onGround = true): number {
  const def = BLOCKS[blockId];
  const digTime = def?.digTime ?? 1;
  const hasteLvl = haste === true ? 1 : haste || 0;
  // MC：急迫 +20%/级；头在水中挖掘 5 倍慢；脚不沾地（悬空）也 5 倍慢
  let speedMul = (1 + 0.2 * hasteLvl) / (underwater ? 5 : 1) / (onGround ? 1 : 5);
  let harvest = false;
  if (held?.kind === 'tool') {
    const tool = TOOLS[held.tool];
    // Java：destroySpeed 只看工具类别是否匹配方块，与采掘层级无关；层级只影响掉落
    const classMatch = tool.kind !== 'sword' && def?.tool === tool.kind;
    // 需镐方块的可采掘判定（needsPick 任意镐；pickTier 限定最低层级）：达标切 ×1.5 基值并可掉落
    const needTier = def?.pickTier ?? (def?.needsPick ? 0 : null);
    harvest = classMatch && (needTier === null || TIER_ORDER.indexOf(tool.tier) >= needTier);
    // 剪刀走硬编码倍率特判（不参与 tool 字段匹配）
    const speed = classMatch ? tool.speed : tool.kind === 'shears' ? shearSpeed(def?.key) : 1;
    if (speed > 1) {
      // MC Java 效率附魔：速度 > 1 时 + (等级²+1)（效率 V：+26；层级不足同样生效）
      const eff = held.ench?.efficiency ?? 0;
      speedMul *= speed + (eff > 0 ? eff * eff + 1 : 0);
    }
  }
  // 需镐方块是 ×5 基值，可采掘时切到 ×1.5 基值（1.5/5 = 0.3）；徒手可采方块本就是 ×1.5 基值
  const base = harvest && (def?.needsPick === true || def?.pickTier !== undefined) ? digTime * 0.3 : digTime;
  return base / speedMul;
}
