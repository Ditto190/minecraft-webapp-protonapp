// 树苗生长与树叶凋零：树苗计时成树（MC 随机刻观感：所在格光照 ≥9 才长，深色橡木/丛林巨树须 2×2 四棵苗），
// 树叶按 Java distance 模型凋零：沿树叶连通的 6 邻 BFS 到最近原木，距离 >6 才枯，并按树种概率掉树苗/木棍；
// 玩家放置的树叶登记 persistent（Java），永不凋零

import { AIR, BLOCKS, BLOCK_BY_KEY, isWaterId, type BlockId } from './blocks';
import { dayFactorAt, worldClock } from './game';
import { spawnMaterialDrop } from './items';
import { mulberry32, type TreeKind } from './noise';
import { MEGA_JUNGLE_MAX_H, TREE_MAX_H, writeMegaJungle, writeTree } from './trees';
import { type World } from './world';
import { WORLD_HEIGHT } from './grid';
import { registerWorldScope } from './worldScope';

/** 原木（含去皮）判定：叶子的供养来源 */
export function isLogId(id: BlockId): boolean {
  const k = BLOCKS[id]?.key;
  return k === 'log' || k?.endsWith('_log') === true;
}

/** 树叶判定 */
export function isLeavesId(id: BlockId): boolean {
  const k = BLOCKS[id]?.key;
  return k === 'leaves' || k?.endsWith('_leaves') === true;
}

/** 树叶 → 对应树苗（凋零掉落用） */
export const LEAF_TO_SAPLING: Record<string, string> = {
  leaves: 'oak_sapling',
  spruce_leaves: 'spruce_sapling',
  birch_leaves: 'birch_sapling',
  jungle_leaves: 'jungle_sapling',
  acacia_leaves: 'acacia_sapling',
  dark_oak_leaves: 'dark_oak_sapling',
  mangrove_leaves: 'mangrove_sapling',
  cherry_leaves: 'cherry_sapling',
};

// ——— 树苗追踪与生长 ———

const saplings = new Set<string>();
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

// ——— 玩家放置树叶（Java LeavesBlock persistent=true）：登记后凋零扫描跳过 ———

/**
 * 玩家放置的树叶坐标集（key 格式同 saplings）。Java 以方块状态 persistent 旗标实现；
 * 本项目 chunk data 无旗标位，用内存集合登记，故不随存档持久化——重载后恢复可凋零（可接受的简化）。
 * 登记：actions 放置分支 markPlacedLeaves；除名：notifyBlockSet 中该格被替换为任何非树叶方块。
 */
const placedLeaves = new Set<string>();

/** 玩家放置树叶时登记（仅 actions 放置分支调用；树生长/世界生成的树叶不经此路径，保持可凋零） */
export function markPlacedLeaves(x: number, y: number, z: number): void {
  placedLeaves.add(key(x, y, z));
}

/** setBlock 钩子：树苗登记/注销 + 原木破坏时登记树叶检查（world.setBlock 统一调用） */
export function notifyBlockSet(world: World, x: number, y: number, z: number, oldId: BlockId, newId: BlockId): void {
  const k = key(x, y, z);
  if (BLOCKS[newId]?.treeWood) saplings.add(k);
  else saplings.delete(k);
  // 树叶被替换/破坏（含爆炸、树干顶穿）：persistent 除名。新树叶由生长/生成写入时不登记——只有玩家放置才登记
  if (!isLeavesId(newId)) placedLeaves.delete(k);
  // 原木或树叶变化会改变周围叶子的 distance，失效缓存
  if (isLogId(oldId) || isLogId(newId) || isLeavesId(oldId) || isLeavesId(newId)) {
    invalidateLeafDistanceCache(x, y, z);
  }
  if (isLogId(oldId) && !isLogId(newId)) {
    // 原木没了：6 格内（distance 模型最远供养距离）的树叶进入凋零检查队列
    for (let dx = -6; dx <= 6; dx++) {
      for (let dy = -6; dy <= 6; dy++) {
        for (let dz = -6; dz <= 6; dz++) {
          if (isLeavesId(world.getBlock(x + dx, y + dy, z + dz))) {
            leafQueue.add(key(x + dx, y + dy, z + dz));
          }
        }
      }
    }
  }
}

/**
 * 树苗长成一棵树（与世界生成同形，共用 lib/trees.ts 树形库；y 为树苗格，地表即 y-1）。
 * mega=true 时长丛林巨树（2×2 四棵丛林苗，锚点为方阵西南角，见 writeMegaJungle）
 */
export function growTree(world: World, x: number, y: number, z: number, wood: string, mega = false): void {
  const kind = wood as TreeKind;
  if (y + (mega ? MEGA_JUNGLE_MAX_H : TREE_MAX_H[kind]) >= WORLD_HEIGHT) return; // 顶到世界放不下，保留树苗
  const rand = mulberry32((Math.imul(x, 374761393) ^ Math.imul(y, 2246822519) ^ Math.imul(z, 668265263)) | 0);
  const put = (px: number, py: number, pz: number, id: BlockId, onlyAir: boolean) => {
    const cur = world.getBlock(px, py, pz);
    // 树干替换空气/水/树叶/十字花草（含树苗自身），树叶只占空气/水，其他占用（箱子、屋顶等）跳过
    const ok = onlyAir
      ? cur === AIR || isWaterId(cur)
      : cur === AIR || isWaterId(cur) || isLeavesId(cur) || BLOCKS[cur]?.shape === 'cross';
    if (ok) world.setBlock(px, py, pz, id);
  };
  if (mega) writeMegaJungle(put, x, y - 1, z, rand);
  else writeTree(put, kind, x, y - 1, z, rand);
}

let growAcc = 0;
const rand = mulberry32(0x9e3779b9);

// ——— 树叶 distance 缓存 ———
/** leafDistanceToLog 结果缓存：key → distance（≤6 或 Infinity）；原木/树叶在 6 格内变化时失效 */
const leafDistanceCache = new Map<string, number>();

function invalidateLeafDistanceCache(x: number, y: number, z: number): void {
  // 保守失效：变化点周围 6 格立方内的 distance 都可能改变
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dz = -6; dz <= 6; dz++) {
        leafDistanceCache.delete(key(x + dx, y + dy, z + dz));
      }
    }
  }
}

// ——— 树叶凋零队列 ———

// Set 去重（key 格式同 saplings）：同一树叶被多根原木扫到只入队一次
const leafQueue = new Set<string>();

/** 6 邻面方向（Java 树叶 distance 只沿面相邻传播；凋零级联同用） */
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/**
 * 树叶的 distance（Java 方块状态 1-7）：沿 6 邻连通的树叶格 BFS 到最近原木的步数。
 * ≤6 有原木供养（存活），找不到（Java distance=7）即凋零。
 * BFS 深度限 6，波及范围不出切比雪夫 6 格立方；未加载 chunk 不算供养（防 getBlock 隐式触发生成）。
 */
export function leafDistanceToLog(world: World, x: number, y: number, z: number): number {
  const k = key(x, y, z);
  const cached = leafDistanceCache.get(k);
  if (cached !== undefined) return cached;
  const visited = new Set<string>([k]);
  let frontier: [number, number, number][] = [[x, y, z]];
  for (let d = 1; d <= 6 && frontier.length > 0; d++) {
    const next: [number, number, number][] = [];
    for (const [cx, cy, cz] of frontier) {
      for (const [dx, dy, dz] of FACES) {
        const nx = cx + dx;
        const ny = cy + dy;
        const nz = cz + dz;
        if (!world.isChunkLoaded(nx, nz)) continue;
        const id = world.getBlock(nx, ny, nz);
        if (isLogId(id)) {
          leafDistanceCache.set(k, d);
          return d;
        }
        if (!isLeavesId(id)) continue;
        const nk = key(nx, ny, nz);
        if (visited.has(nk)) continue;
        visited.add(nk);
        next.push([nx, ny, nz]);
      }
    }
    frontier = next;
  }
  leafDistanceCache.set(k, Infinity);
  return Infinity;
}

/** 树苗所在格的有效光照：方块光与（白天时的）天空光取大者（采样方式同 lib/crops.ts） */
function lightAt(world: World, x: number, y: number, z: number, day: boolean): number {
  const c = world.chunks.get(`${x >> 4},${z >> 4}`);
  if (!c) return 0;
  // localIndex 公式与 world.ts 一致（此处内联避免运行时循环依赖）
  const i = (y * 16 + (z & 15)) * 16 + (x & 15);
  return Math.max(c.light[i], day ? c.sky[i] : 0);
}

/**
 * 2×2 苗阵定位（MC：深色橡木/丛林巨树必须四棵苗才生长，单苗永不长或只长普通树）：
 * 在 (x,z) 参与的 4 个候选方阵中，返回第一个四棵同为同层 wood 种苗的方阵锚点（即粗干西南角）
 */
function saplingSquareAt(world: World, x: number, y: number, z: number, wood: TreeKind): [number, number] | null {
  for (const ax of [x, x - 1]) {
    for (const az of [z, z - 1]) {
      let ok = true;
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const bx = ax + dx;
        const bz = az + dz;
        // isChunkLoaded 防 getBlock 隐式触发邻 chunk 生成
        if (!world.isChunkLoaded(bx, bz) || BLOCKS[world.getBlock(bx, y, bz)]?.treeWood !== wood) {
          ok = false;
          break;
        }
      }
      if (ok) return [ax, az];
    }
  }
  return null;
}

/**
 * 每 ~2s 调用：树苗按 1/25 概率成树（平均 ~50s；MC 规则：所在格光照 ≥9 才长，
 * 深色橡木须 2×2 四棵苗，丛林 2×2 四棵苗长成巨树、长成时四棵同消）；凋零队列逐个检查，
 * 玩家放置的（persistent 登记）跳过，其余按 Java distance 模型判定：沿树叶 6 邻 BFS 到最近
 * 原木距离 >6 的枯萎（丛林 2.5%、其他 5% 掉对应树苗；所有树叶 2% 掉木棍），并级联检查邻居
 */
export function tickSaplings(world: World, dt: number): void {
  growAcc += dt;
  if (growAcc < 2) return;
  growAcc = 0;

  const day = dayFactorAt(worldClock.t) > 0.4;
  const handled = new Set<string>(); // 本 tick 已处理过的 2×2 方阵角点/单苗，避免重复检查
  for (const k of [...saplings]) {
    if (handled.has(k)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (!world.chunks.has(`${x >> 4},${z >> 4}`)) continue; // 未加载的不管
    const def = BLOCKS[world.getBlock(x, y, z)];
    if (!def?.treeWood) {
      saplings.delete(k); // 已非树苗（被移除/存档覆盖的失效登记），立即除名
      continue;
    }
    if (lightAt(world, x, y, z, day) < 9) continue; // MC：光照不足不生长
    if (def.treeWood === 'dark_oak') {
      const square = saplingSquareAt(world, x, y, z, 'dark_oak');
      if (!square) continue; // 凑不齐 2×2 四棵苗：永不生长
      for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) handled.add(key(square[0] + dx, y, square[1] + dz));
      if (rand() < 1 / 25) {
        growTree(world, square[0], y, square[1], 'dark_oak');
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          saplings.delete(key(square[0] + dx, y, square[1] + dz)); // 四棵一并除名（树干已由 growTree 落位）
        }
      }
      continue;
    }
    if (def.treeWood === 'jungle') {
      // MC：丛林苗 2×2 四棵长成巨树；单苗走下方通用路径长普通丛林树
      const square = saplingSquareAt(world, x, y, z, 'jungle');
      if (square) {
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) handled.add(key(square[0] + dx, y, square[1] + dz));
        if (rand() < 1 / 25) {
          growTree(world, square[0], y, square[1], 'jungle', true);
          for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            saplings.delete(key(square[0] + dx, y, square[1] + dz)); // 四棵一并除名（粗干已由 growTree 落位）
          }
        }
        continue; // 已成阵的丛林苗不再走单苗普通树路径
      }
    }
    handled.add(k);
    if (rand() < 1 / 25) {
      growTree(world, x, y, z, def.treeWood);
      saplings.delete(k);
    }
  }

  let budget = 64;
  while (budget-- > 0 && leafQueue.size > 0) {
    const k = leafQueue.values().next().value!;
    leafQueue.delete(k);
    const [x, y, z] = k.split(',').map(Number);
    const id = world.getBlock(x, y, z);
    if (!isLeavesId(id)) continue;
    if (placedLeaves.has(k)) continue; // 玩家放置的树叶（Java persistent=true）：永不凋零
    if (leafDistanceToLog(world, x, y, z) <= 6) continue; // Java distance ≤6：仍有原木供养
    world.setBlock(x, y, z, AIR);
    // MC：枯萎时概率掉对应树苗——丛林 2.5%，其他 5%（掉在原地，由调用方转掉落物）；
    // 橡木/深色橡木另有 0.5% 掉苹果，但本作无苹果物品，跳过
    const leafKey = BLOCKS[id].key;
    const saplingKey = LEAF_TO_SAPLING[leafKey];
    if (saplingKey && rand() < (leafKey === 'jungle_leaves' ? 0.025 : 0.05)) {
      onSaplingDrop?.(BLOCK_BY_KEY[saplingKey].id, x + 0.5, y + 0.3, z + 0.5);
    }
    // MC：所有树叶 2% 掉 1-2 木棍（本作简化为 1 根；材料掉落不走方块掉落回调）
    if (rand() < 0.02) spawnMaterialDrop('stick', x + 0.5, y + 0.3, z + 0.5, 1);
    // 级联：邻居树叶继续检查（浮空树叶由内向外逐级消失）
    for (const [dx, dy, dz] of FACES) {
      if (isLeavesId(world.getBlock(x + dx, y + dy, z + dz))) {
        leafQueue.add(key(x + dx, y + dy, z + dz));
      }
    }
  }
}

/** 树苗掉落回调（actions 注入，避免循环依赖） */
let onSaplingDrop: ((id: BlockId, x: number, y: number, z: number) => void) | null = null;
export function setSaplingDropHandler(fn: typeof onSaplingDrop): void {
  onSaplingDrop = fn;
}

/** 清空树苗登记、persistent 树叶登记、凋零队列与 distance 缓存（切换世界时调用） */
export function clearSaplings(): void {
  saplings.clear();
  placedLeaves.clear();
  leafQueue.clear();
  leafDistanceCache.clear();
}

/**
 * chunk 首次进入世界（新生成/读档恢复）或数据被存档整体替换时重扫登记树苗：
 * 世界生成与存档恢复都直写 chunk data，不走 world.setBlock 钩子，登记只能事后补扫。
 * 幂等（重复扫描只是重复 add）；数据替换留下的失效登记由 tickSaplings 自检除名。
 */
export function rescanSaplingsChunk(world: World, cx: number, cz: number): void {
  const c = world.chunks.get(`${cx},${cz}`);
  if (!c) return;
  const bx = cx << 4;
  const bz = cz << 4;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (BLOCKS[c.data[(y * 16 + z) * 16 + x]]?.treeWood) saplings.add(key(bx + x, y, bz + z));
      }
    }
  }
}

// 世界作用域自注册（lib/worldScope.ts）：树苗/树叶队列随世界清理
registerWorldScope({ name: 'saplings', clear: clearSaplings });
