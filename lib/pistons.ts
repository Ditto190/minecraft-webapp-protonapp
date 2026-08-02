// 活塞机械：供能推出（至多 12 格）、断能收回、粘性拉回、孤儿头清理
// 黏液块/蜂蜜块粘连（Java 飞行器/门核心）：推/拉时以推出线为种子做图遍历，粘住相邻可推方块一起动，
// 被带动的黏液/蜂蜜块继续连带（递归）；总移动数仍受 12 上限（超出整次失败）。
// 黏液与蜂蜜互不粘；不可推块/活塞/粉·火把等附着类（被推时破坏）不参与粘连（推线内被直接推仍按原样搬移）。
// 状态完全由方块布局推导（活塞 facing + 前方活塞头），无需持久化
// 被活塞移动的侦测器记入 pushedObservers（redstone tick 消费：Java 中侦测器被推后发出一次脉冲——飞行器原理）

import { AIR, BLOCK_BY_KEY, BLOCKS, isWaterId, isLavaId, type BlockId } from './blocks';
import type { World } from './world';

const HEAD = () => BLOCK_BY_KEY.piston_head.id;

const pistonKey = (id: BlockId): string => BLOCKS[id]?.key ?? '';

const posKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** 被活塞移动到新位置的侦测器（推/拉均记；redstone 每 tick 取出并让其在下一红石刻发脉冲） */
export const pushedObservers = new Set<string>();

const isObserverBlock = (id: BlockId): boolean => pistonKey(id).startsWith('observer_');

export const isPistonId = (id: BlockId): boolean => {
  const k = pistonKey(id);
  return k.startsWith('piston_') && k !== 'piston_head';
};
export const isStickyPistonId = (id: BlockId): boolean => pistonKey(id).startsWith('piston_sticky_');
export const isPistonPart = (id: BlockId): boolean => isPistonId(id) || id === HEAD();

/** 活塞 id：粘性与否 × 朝向（0-5） */
export function pistonIdFor(sticky: boolean, facing: number): number {
  const suf = ['n', 'e', 's', 'w', 'u', 'd'][facing] ?? 'n';
  return BLOCK_BY_KEY[`piston_${sticky ? 'sticky_' : ''}${suf}`].id;
}

/** 朝向向量（0-5：n/e/s/w/上/下） */
export const FACING_VEC: Record<number, [number, number, number]> = {
  0: [0, 0, -1],
  1: [1, 0, 0],
  2: [0, 0, 1],
  3: [-1, 0, 0],
  4: [0, 1, 0],
  5: [0, -1, 0],
};

/** 不可推动（MC 规则简化：不可破坏方块 + 黑曜石类 + 容器/功能方块 + 流体 + 活塞自身） */
function immovable(id: BlockId): boolean {
  if (id === AIR) return false;
  const def = BLOCKS[id];
  if (!def) return true;
  if (def.unbreakable) return true; // 基岩/强化深板岩/传送门类
  if (isWaterId(id) || isLavaId(id)) return true;
  if (isPistonPart(id)) return true;
  const key = def.key;
  // MC 明确不可推：黑曜石类与容器/功能方块（远古残骸虽需同级镐挖掘，但 MC 可推，不在此列）
  return key === 'obsidian' || key === 'crying_obsidian' || key === 'chest' || key === 'barrel' || key === 'furnace' || key === 'brewing_stand' || key === 'enchanting_table';
}

/** 0=非粘连块 1=黏液块 2=蜂蜜块 */
const stickyKind = (id: BlockId): 0 | 1 | 2 => {
  const k = pistonKey(id);
  return k === 'slime_block' ? 1 : k === 'honey_block' ? 2 : 0;
};

/** 粘连兼容（Java）：黏液与蜂蜜互不粘；粘/非粘之间可粘（单向拉动） */
const canStick = (a: BlockId, b: BlockId): boolean => {
  const sa = stickyKind(a);
  const sb = stickyKind(b);
  return sa === 0 || sb === 0 || sa === sb;
};

/** 附着类（粉/火把/植物等 solid:false，Java 中被推时破坏）：不被粘连带走（推线内被直接推仍按现状整体搬移） */
const breaksOnPush = (id: BlockId): boolean => id !== AIR && BLOCKS[id]?.solid === false;

const MAX_PUSH = 12;

type MoveSet = Map<string, [number, number, number, BlockId]>;

/** 以 (sx,sy,sz) 为种子、沿运动方向 (dx,dy,dz) 收集本次位移的方块集合：
 *  正前方的块被推挤必随动（撞不可推块整次失败）；黏液/蜂蜜块再粘住六邻的可推方块（递归连带）。
 *  返回 null = 推不动（撞不可推块/超 12 上限，上限计入被粘连方块）；空 Map = 前方全空 */
function collectMoveSet(world: World, sx: number, sy: number, sz: number, dx: number, dy: number, dz: number): MoveSet | null {
  const move: MoveSet = new Map();
  const queue: [number, number, number][] = [[sx, sy, sz]];
  while (queue.length > 0) {
    const [x, y, z] = queue.pop()!;
    if (move.has(posKey(x, y, z))) continue;
    const id = world.getBlock(x, y, z);
    if (id === AIR) continue; // 空位：该分支到头
    if (immovable(id)) return null; // 位移路径上撞不可推块：整次失败（MC）
    if (move.size >= MAX_PUSH) return null; // 超 12 块上限（含被粘连方块）：整次失败
    move.set(posKey(x, y, z), [x, y, z, id]);
    queue.push([x + dx, y + dy, z + dz]); // 正前方的块被推挤，必须跟着动
    if (stickyKind(id) === 0) continue; // 非粘连块不带动邻块（其前方已由推挤覆盖）
    for (const [nx, ny, nz] of Object.values(FACING_VEC)) {
      if (nx === dx && ny === dy && nz === dz) continue; // 正前方已由推挤覆盖
      const bx = x + nx;
      const by = y + ny;
      const bz = z + nz;
      const nid = world.getBlock(bx, by, bz);
      // 不粘连的例外：空气、不可推块（含活塞/活塞头）、附着类、黏液×蜂蜜
      if (nid === AIR || immovable(nid) || breaksOnPush(nid) || !canStick(id, nid)) continue;
      queue.push([bx, by, bz]);
    }
  }
  return move;
}

/** 统一位移：先清后放避免互相覆盖；逐块 setBlock 走既有钩子（notifyRedstone 等）；被移侦测器记新位置 */
function applyMove(world: World, move: MoveSet, dx: number, dy: number, dz: number): void {
  for (const [x, y, z] of move.values()) world.setBlock(x, y, z, AIR);
  for (const [x, y, z, id] of move.values()) {
    world.setBlock(x + dx, y + dy, z + dz, id);
    if (isObserverBlock(id)) pushedObservers.add(posKey(x + dx, y + dy, z + dz)); // 侦测器被推/拉：记新位置
  }
}

/** 供能推出：前方一行 + 黏液/蜂蜜粘连块（合计 ≤12）整体前移一格并放活塞头（朝空也正常出头，MC）；不可推/超上限则不动 */
export function tryExtend(world: World, x: number, y: number, z: number): void {
  const def = BLOCKS[world.getBlock(x, y, z)];
  const f = def?.facing ?? 4;
  const [dx, dy, dz] = FACING_VEC[f];
  const move = collectMoveSet(world, x + dx, y + dy, z + dz, dx, dy, dz);
  if (move === null) return; // 撞不可推块/超 12 上限：整次推不出（MC）
  applyMove(world, move, dx, dy, dz);
  world.setBlock(x + dx, y + dy, z + dz, HEAD());
}

/** 断能收回：移除活塞头；粘性活塞把头部前方的块（含黏液/蜂蜜粘连块，合计 ≤12）拉回（MC 粘性规则）。
 *  leavePulled：粘性活塞 1-tick 短脉冲（供电 ≤1 红石刻）收回时不拉回方块——块留在推到位（MC Java） */
export function retract(world: World, x: number, y: number, z: number, leavePulled = false): void {
  const def = BLOCKS[world.getBlock(x, y, z)];
  const sticky = isStickyPistonId(world.getBlock(x, y, z));
  const f = def?.facing ?? 4;
  const [dx, dy, dz] = FACING_VEC[f];
  const hx = x + dx;
  const hy = y + dy;
  const hz = z + dz;
  if (world.getBlock(hx, hy, hz) !== HEAD()) return;
  world.setBlock(hx, hy, hz, AIR);
  if (!sticky || leavePulled) return;
  // 粘性：把再前一格的块（连同粘连块）拉向头部原位置；拉不动（不可推/超上限）则只收头（MC）
  const move = collectMoveSet(world, hx + dx, hy + dy, hz + dz, -dx, -dy, -dz);
  if (move === null || move.size === 0) return;
  applyMove(world, move, -dx, -dy, -dz);
}

/** 孤儿活塞头清理：无活塞 facing 指向头格时自动消失（recompute/变动时调用） */
export function cleanupOrphanHeads(world: World, x: number, y: number, z: number): void {
  if (world.getBlock(x, y, z) !== HEAD()) return;
  for (const [f, [dx, dy, dz]] of Object.entries(FACING_VEC)) {
    const id = world.getBlock(x - dx, y - dy, z - dz);
    // 仅当邻格活塞 facing 指向头格才算有主（侧向贴着的无关活塞不保护）
    if (isPistonId(id) && BLOCKS[id]?.facing === Number(f)) return;
  }
  world.setBlock(x, y, z, AIR);
}

/** 该活塞是否处于推出态（前方是活塞头） */
export function isExtended(world: World, x: number, y: number, z: number): boolean {
  const def = BLOCKS[world.getBlock(x, y, z)];
  const f = def?.facing ?? 4;
  const [dx, dy, dz] = FACING_VEC[f];
  return world.getBlock(x + dx, y + dy, z + dz) === HEAD();
}
