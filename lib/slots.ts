// 热键栏槽位模型与纯函数操作（不依赖 store，可单测）

import type { ArmorMaterial, ArmorPiece } from './armor';
import type { BlockId } from './blocks';
import type { ToolType } from './tools';
import type { EnchMap } from './xp';

/** 槽位：方块堆叠 / 材料 / 工具 / 装备（不可堆叠，带耐久；工具/装备可带附魔）。
 *  收纳袋（Java 1.21.2 bundle）是 material 槽 + bundleItems 内容物：count 恒为 1，行为按不可堆叠处理 */
export type Slot =
  | { kind: 'block'; id: BlockId; count: number }
  | { kind: 'material'; material: string; count: number; /** 收纳袋内容物（仅 material === BUNDLE_MATERIAL 时有意义）；缺省 = 空袋，兼容无此字段的旧存档 */ bundleItems?: Slot[] }
  | { kind: 'tool'; tool: ToolType; durability: number; ench?: EnchMap; /** 铁砧累计使用次数（MC prior work penalty：费用 +2^n-1 级） */ works?: number }
  | { kind: 'armor'; piece: ArmorPiece; material?: ArmorMaterial; durability: number; ench?: EnchMap; works?: number }
  | null;

// ——— 收纳袋（Java 1.21.2）：袋内多种物品合计 64 容量点，每件占 64/该物品最大堆叠 点，不可堆叠占 64 点=满袋 ———

/** 收纳袋材料名。lib/materials.ts 不归本特性所有故未注册（显示名/创造物品栏走各自回退），取用统一用 emptyBundle() */
export const BUNDLE_MATERIAL = 'bundle';
/** 收纳袋显示名（tooltip 用；materials.ts 注册前的回退） */
export const BUNDLE_NAME = '收纳袋';
/** 收纳袋容量点数（Java：64 点） */
export const BUNDLE_CAPACITY = 64;

/** Java 最大堆叠 16 的材料（本项目槽位统一按 64 堆叠，仅收纳袋容量按 Java 最大堆叠计费：4 点/个） */
const STACK16_MATERIALS = new Set(['ender_pearl', 'snowball', 'egg']);

/** 收纳袋槽位（material 变体，material 字面量 'bundle'；窄化目标独立于 material 变体，反向窄化不会吞掉普通材料） */
export type BundleSlot = { kind: 'material'; material: 'bundle'; count: number; bundleItems?: Slot[] };

/** 槽位是否为收纳袋（material 槽 + bundle 材料名；count 恒为 1，内容物在 bundleItems） */
export function isBundleSlot(slot: Slot): slot is BundleSlot {
  return slot !== null && slot.kind === 'material' && slot.material === BUNDLE_MATERIAL;
}

/** 空收纳袋 */
export function emptyBundle(): Slot {
  return { kind: 'material', material: BUNDLE_MATERIAL, count: 1, bundleItems: [] };
}

/** 单件物品占用的收纳袋容量点（Java：64/最大堆叠；工具/装备不可堆叠 = 64 点占满整袋） */
export function bundleUnits(slot: NonNullable<Slot>): number {
  if (slot.kind === 'tool' || slot.kind === 'armor') return BUNDLE_CAPACITY;
  if (slot.kind === 'material' && STACK16_MATERIALS.has(slot.material)) return BUNDLE_CAPACITY / 16;
  return 1;
}

/** 收纳袋内容物（无 bundleItems 字段 = 空袋，兼容旧存档；非袋槽位返回空） */
export function bundleContents(slot: Slot): Slot[] {
  return isBundleSlot(slot) ? (slot.bundleItems ?? []) : [];
}

/** 已占用容量点（0..BUNDLE_CAPACITY） */
export function bundleUsed(slot: Slot): number {
  let used = 0;
  for (const s of bundleContents(slot)) {
    if (s) used += (isStackSlot(s) ? s.count : 1) * bundleUnits(s);
  }
  return used;
}

/** 可堆叠的槽位（方块/材料；收纳袋除外——袋不可堆叠） */
function isStackSlot(slot: Slot): slot is { kind: 'block'; id: BlockId; count: number } | { kind: 'material'; material: string; count: number } {
  return slot !== null && (slot.kind === 'block' || (slot.kind === 'material' && !isBundleSlot(slot)));
}

export const HOTBAR_SIZE = 9;
/** 背包（热键栏之外的主物品栏）格数：MC 3×9 */
export const BACKPACK_SIZE = 27;

export function emptySlots(): Slot[] {
  return Array.from({ length: HOTBAR_SIZE }, () => null);
}

export function emptyBackpack(): Slot[] {
  return Array.from({ length: BACKPACK_SIZE }, () => null);
}

export const STACK_MAX = 64; // MC 一组 64

/** 向槽位添加可堆叠物品，返回放不下的数量 */
export function addStackToSlots(
  slots: Slot[],
  item: { kind: 'block'; id: BlockId } | { kind: 'material'; material: string },
  count: number,
): { slots: Slot[]; leftover: number } {
  const next = [...slots];
  const key = item.kind === 'block' ? `block:${item.id}` : `material:${item.material}`;
  let left = count;
  let changed = false; // 完全放不下时原样返回 slots（store 用数组身份判断是否 set）
  // 先合并进已有堆叠
  for (let i = 0; i < next.length && left > 0; i++) {
    const s = next[i];
    if (!isStackSlot(s)) continue;
    const k = s.kind === 'block' ? `block:${s.id}` : `material:${s.material}`;
    if (k !== key) continue;
    const add = Math.min(STACK_MAX - s.count, left);
    if (add > 0) {
      next[i] = { ...s, count: s.count + add };
      left -= add;
      changed = true;
    }
  }
  // 再放进空槽
  for (let i = 0; i < next.length && left > 0; i++) {
    if (next[i] !== null) continue;
    const add = Math.min(STACK_MAX, left);
    next[i] = item.kind === 'block' ? { kind: 'block', id: item.id, count: add } : { kind: 'material', material: item.material, count: add };
    left -= add;
    changed = true;
  }
  return { slots: changed ? next : slots, leftover: left };
}

/** 给工具找一个空槽，满则返回 null */
export function addToolToSlots(slots: Slot[], tool: ToolType, durability: number, ench?: EnchMap): Slot[] | null {
  const i = slots.indexOf(null);
  if (i < 0) return null;
  const next = [...slots];
  next[i] = { kind: 'tool', tool, durability, ench };
  return next;
}

/** 给装备找一个空槽，满则返回 null */
export function addArmorToSlots(slots: Slot[], piece: ArmorPiece, durability: number, material?: ArmorMaterial, ench?: EnchMap): Slot[] | null {
  const i = slots.indexOf(null);
  if (i < 0) return null;
  const next = [...slots];
  next[i] = { kind: 'armor', piece, material, durability, ench };
  return next;
}

/** 材料聚合计数：'block:<id>' 与 'material:<name>' */
export function countsOf(slots: Slot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of slots) {
    if (!isStackSlot(s)) continue;
    const key = s.kind === 'block' ? `block:${s.id}` : `material:${s.material}`;
    counts[key] = (counts[key] ?? 0) + s.count;
  }
  return counts;
}
