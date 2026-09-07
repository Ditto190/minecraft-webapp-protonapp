// 掉落物实体：破坏方块/死亡时生成，旋转浮动，延时拾取，5 分钟消失。纯数据逻辑（可单测）

import { BLOCKS, type BlockId } from './blocks';
import type { ArmorMaterial, ArmorPiece } from './armor';
import type { ToolType } from './tools';
import type { World } from './world';
import type { EnchMap } from './xp';
import { registerWorldScope } from './worldScope';

export type DropKind =
  | { kind: 'block'; blockId: BlockId }
  | { kind: 'material'; material: string }
  | { kind: 'tool'; tool: ToolType }
  | { kind: 'armor'; piece: ArmorPiece; material?: ArmorMaterial };

export interface ItemDrop {
  id: number;
  drop: DropKind;
  count: number;
  /** 可合并身份键（spawn 时算一次缓存；工具/装备为 null 不参与合并）——避免合并扫描逐个现场拼字符串 */
  mergeKey: string | null;
  /** 工具/装备的剩余耐久（其他类别为 undefined） */
  durability?: number;
  /** 工具/装备的附魔（透传，避免死亡/容器掉落丢附魔） */
  ench?: EnchMap;
  x: number;
  y: number;
  z: number;
  /** 水平速度（Java 手动丢弃向前抛出，格/秒；挖掘/死亡掉落为 0）。旧数据缺省视为 0（tnt.ts vx/vz 同款模式） */
  velX?: number;
  velZ?: number;
  velY: number;
  /** 已存在秒数（>0.5 才可拾取，>300 消失） */
  age: number;
}

/** 水平初速（目前只有 Java 手动丢弃的向前抛出；挖掘/生物掉落不传 = 无初速） */
export interface DropVel {
  x: number;
  z: number;
}

export const itemDrops: ItemDrop[] = [];

const GRAVITY = 18;
const PICKUP_DELAY = 0.5; // MC：掉落 0.5 秒后才能拾取
const PICKUP_RANGE = 1.25;
const LIFETIME = 300; // MC：5 分钟消失
const MAX_DROPS = 256;
/** 同种掉落物合并半径（MC 观感：落点相近的同种掉落并成一堆） */
const MERGE_RADIUS = 1;
/** 合并堆叠上限（与背包一致） */
const MAX_STACK = 64;
/** Java 手动丢弃（Q）的抛出速度（格/秒）：沿视线水平分量抛出（store.ts spawnManualDrop 传入） */
export const MANUAL_DROP_THROW_SPEED = 3;
/** 水平速度阻尼（1/秒）：约 0.23s 减半——抛出抛物线短促，落地即停，不会无限滑行 */
const DROP_DRAG = 3;
/** 掉落物水平半径（撞墙判定余量；渲染缩放 0.25 ≈ 半宽 0.125） */
const DROP_HALF = 0.15;

let nextId = 1;

/** 可合并身份键：仅方块/材料（工具/装备有耐久/附魔个体差异，一律不合并） */
function mergeKeyOf(drop: DropKind): string | null {
  if (drop.kind === 'block') return `b:${drop.blockId}`;
  if (drop.kind === 'material') return `m:${drop.material}`;
  return null;
}

/**
 * 可合并堆索引：mergeKey → 未满（count<64）堆的引用集合（插入序 = itemDrops 顺序，合并扫描顺序与原线性扫一致）。
 * spawn 合并写满 / tickDrops 移除 / MAX_DROPS 挤出时同步维护，杜绝失效引用——爆炸一帧上百次 spawn 从 O(n²) 降到 O(n)
 */
const mergeIndex = new Map<string, Set<ItemDrop>>();

function indexDrop(d: ItemDrop): void {
  if (d.mergeKey === null || d.count >= MAX_STACK) return;
  let set = mergeIndex.get(d.mergeKey);
  if (!set) {
    set = new Set();
    mergeIndex.set(d.mergeKey, set);
  }
  set.add(d);
}

function unindexDrop(d: ItemDrop): void {
  if (d.mergeKey === null) return;
  const set = mergeIndex.get(d.mergeKey);
  if (set && set.delete(d) && set.size === 0) mergeIndex.delete(d.mergeKey);
}

/** 移除 itemDrops[i]（splice + 索引剔除）；tickDrops 倒序遍历内使用安全 */
function removeDropAt(i: number): void {
  unindexDrop(itemDrops[i]);
  itemDrops.splice(i, 1);
}

function spawn(drop: DropKind, x: number, y: number, z: number, count: number, durability?: number, ench?: EnchMap, vel?: DropVel): void {
  const mk = mergeKeyOf(drop);
  if (mk) {
    // 附近同种掉落并入现存堆（不超过 64）；Java：合并保留被并入堆的原年龄，不刷新消失计时
    const set = mergeIndex.get(mk);
    if (set) {
      for (const d of set) {
        if (count <= 0) break;
        const dx = d.x - x;
        const dy = d.y - y;
        const dz = d.z - z;
        if (dx * dx + dy * dy + dz * dz > MERGE_RADIUS * MERGE_RADIUS) continue;
        const take = Math.min(MAX_STACK - d.count, count);
        d.count += take;
        count -= take;
        if (d.count >= MAX_STACK) set.delete(d); // 写满出索引（Set 迭代中删除当前项安全）
      }
      if (set.size === 0) mergeIndex.delete(mk);
    }
    if (count <= 0) return;
  }
  if (itemDrops.length >= MAX_DROPS) {
    // 超上限丢弃最旧的：shift 是 O(n) 但仅在满 256 时触发（罕见），换来索引/遍历语义与数组顺序严格一致，值得保留
    unindexDrop(itemDrops[0]);
    itemDrops.shift();
  }
  const d: ItemDrop = { id: nextId++, drop, count, mergeKey: mk, durability, ench, x, y, z, velX: vel?.x ?? 0, velZ: vel?.z ?? 0, velY: 2, age: 0 };
  itemDrops.push(d);
  indexDrop(d);
}

export function spawnBlockDrop(blockId: BlockId, x: number, y: number, z: number, count = 1, vel?: DropVel): void {
  spawn({ kind: 'block', blockId }, x, y, z, count, undefined, undefined, vel);
}

export function spawnMaterialDrop(material: string, x: number, y: number, z: number, count = 1, vel?: DropVel): void {
  spawn({ kind: 'material', material }, x, y, z, count, undefined, undefined, vel);
}

export function spawnToolDrop(tool: ToolType, x: number, y: number, z: number, durability?: number, ench?: EnchMap, vel?: DropVel): void {
  spawn({ kind: 'tool', tool }, x, y, z, 1, durability, ench, vel);
}

export function spawnArmorDrop(piece: ArmorPiece, x: number, y: number, z: number, durability: number, material?: ArmorMaterial, ench?: EnchMap, vel?: DropVel): void {
  spawn({ kind: 'armor', piece, material }, x, y, z, 1, durability, ench, vel);
}

export function clearDrops(): void {
  itemDrops.length = 0;
  mergeIndex.clear();
}

/**
 * 每帧推进：重力、落地、拾取、消失。
 * onPickup(drop) 返回 true 才移除实体（背包满时可保留）。
 */
export function tickDrops(
  world: World,
  dt: number,
  playerPos: { x: number; y: number; z: number },
  onPickup: (drop: ItemDrop) => boolean,
): void {
  for (let i = itemDrops.length - 1; i >= 0; i--) {
    const d = itemDrops[i];
    d.age += dt;
    if (d.age >= LIFETIME) {
      removeDropAt(i);
      continue;
    }

    // 水平初速（Java 手动丢弃向前抛出）：阻尼衰减 + 逐轴积分，撞实心方块清零（tnt.ts 击退同款最小速度模型，非完整物理）
    const drag = Math.max(0, 1 - DROP_DRAG * dt);
    d.velX = (d.velX ?? 0) * drag;
    d.velZ = (d.velZ ?? 0) * drag;
    if (d.velX !== 0) {
      const nx = d.x + d.velX * dt;
      if (BLOCKS[world.getBlock(Math.floor(nx + Math.sign(d.velX) * DROP_HALF), Math.floor(d.y), Math.floor(d.z))]?.solid) d.velX = 0;
      else d.x = nx;
    }
    if (d.velZ !== 0) {
      const nz = d.z + d.velZ * dt;
      if (BLOCKS[world.getBlock(Math.floor(d.x), Math.floor(d.y), Math.floor(nz + Math.sign(d.velZ) * DROP_HALF))]?.solid) d.velZ = 0;
      else d.z = nz;
    }

    // 重力与落地（中心点下方半格处为底面；单帧最多下落 1 格防穿透）
    d.velY = Math.max(d.velY - GRAVITY * dt, -30);
    let newY = d.y + d.velY * dt;
    if (newY < d.y - 1) newY = d.y - 1;
    d.y = newY;
    const by = Math.floor(d.y - 0.125);
    if (d.velY <= 0 && BLOCKS[world.getBlock(Math.floor(d.x), by, Math.floor(d.z))]?.solid) {
      d.y = by + 1 + 0.125;
      d.velY = 0;
    }
    if (d.y < -10) {
      removeDropAt(i);
      continue;
    }

    // 延时后进入拾取范围
    if (d.age >= PICKUP_DELAY) {
      const dx = playerPos.x - d.x;
      const dy = playerPos.y + 0.5 - d.y;
      const dz = playerPos.z - d.z;
      if (dx * dx + dy * dy + dz * dz < PICKUP_RANGE * PICKUP_RANGE && onPickup(d)) {
        removeDropAt(i);
      }
    }
  }
}

// 世界作用域自注册（lib/worldScope.ts）：掉落物随世界清理
registerWorldScope({ name: 'items', clear: clearDrops });
