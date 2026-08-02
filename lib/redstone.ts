// 红石供能：电源（红石火把/开着的拉杆/红石块/on 态中继器/按下的按钮/踩中的压力板/侦测器与标靶脉冲）
// + 红石粉 BFS 衰减传播 + 元件供能反应。world.setBlock 经 notifyRedstone 触发局部重算；
// 消费端：红石灯亮灭、橡木门开关、TNT 引爆、活塞推收、音符盒发声。
//
// 粉的连接形态（MC Java）：粉除同层 4 邻外，可沿对角上/下坡连接（每步仍只衰减 1 级）——
// 上坡（(x,y,z)→(x±1,y+1,z)/(x,y+1,z±1)）在本格上方 (x,y+1,z) 为实心方块时切断（Java 压线规则）；
// 下坡不被角格实心切断（Java：上方块实心才切断上坡，下坡方向保持连接）。
//
// 粉按指向供能（MC Java）：先按连接形态算出每格粉的水平指向（一字形只指两端、点状指水平四向），
// 粉只弱充能指向的实心方块与正下方块，不供正上方。
//
// 强/弱充能分离（MC Java）：
// 强充能＝红石火把正上方块、中继器/比较器/侦测器输出指向的实心方块（电平＝输出电平）：
//   驱动邻接粉（按电平播种）并激活 6 邻元件；
// 弱充能＝拉杆/按钮/压力板/红石块指向的实心方块，以及被粉按指向弱充能的实心方块：
//   只激活 6 邻元件，不驱动邻接粉（拉杆→方块→粉 不导通）；比较器读粉弱充能的方块取粉的实际电平。
//
// 红石火把反相（NOT 门，MC）：下方附着块被充能（邻接电源/带电粉指向/充能块）时火把熄灭停止供电，
// 失去充能复亮；翻转经 pendingRecompute 下一 tick 生效，等价 MC 的火把延迟。火把不充能自己坐着的支撑块（否则自锁）。
//
// 比较器（MC）：输入→输出延迟 1 红石刻（tickRedstone 到期按实时输入结算，去抖）；输出强充能前方
// 实心方块、播种前方粉并激活前方元件（灯/活塞直连输出面有效）。背向紧贴容器（箱子/木桶/熔炉/酿造台）时
// 输出按容器装满度 0-15（MC Java：signal = 1 + floor(Σ(槽内数量/该物品最大堆叠) / 槽位数 × 14)，空容器 0；
// 满度取代后侧红石信号，接入既有比较/减法逻辑）。容器内容变化不自带方块更新，比较器随每次 recompute 重算。
//
// 红石火把烧毁（burnout，MC Java）：火把在 60 游戏刻（3s，本引擎 30 红石刻）内切换 8 次则烧毁熄灭，
// 输出恒断；收到邻近方块更新（notifyRedstone 经过，火把自身 ON↔OFF 翻转不算）才清除烧毁态，重算时可重燃。
//
// 侦测器（MC Java）：检测面朝格的方块状态签名（方块 id + 粉功率/中继器档位/比较器模式与输出电平），
// 变化后延迟 1 红石刻从背面发出持续 1 红石刻的定向脉冲；被活塞推动后也发出一次脉冲（飞行器原理，
// 经 pistons.pushedObservers 挂接）；放置/加载不触发。
//
// 中继器侧向锁存（MC）：另一充能中继器/比较器从侧面指向中继器时，该中继器锁定，输出保持当前状态。
//
// QC 半连接性（quasi-connectivity，MC Java）：活塞除常规 6 邻供电判定外，把上方一格 (x,y+1,z) 当作门位置
// 再做一次供电判定——对角上方 / 正上方两格的电源也算供能。QC 供能时不立即动作（BUD 态），等活塞收到
// 邻近方块更新（变动格与活塞 6 邻接，notifyRedstone 触发局部重算）才补推出；常规供电仍即时动作。
// （简化：QC 断能后的收回不做 BUD 延迟，随重算即时收回——激活侧 BUD 是玩家主要利用方向。）
//
// 粘性活塞 1-tick 短脉冲（MC Java）：供电结束距供电开始 ≤1 红石刻（0.1s）时，收回不拉回方块（留在推到位）。

import { AIR, BLOCK_BY_KEY, BLOCKS, type BlockId } from './blocks';
import { brews } from './brewing';
import { furnaces } from './furnace';
import { playerPosition } from './game';
import { mobs } from './mobs';
import { cleanupOrphanHeads, FACING_VEC, isExtended, isPistonId, isStickyPistonId, pushedObservers, retract, tryExtend } from './pistons';
import { STACK_MAX } from './slots';
import { noteBlock } from './sound';
import { storages } from './storage';
import { igniteTnt } from './tnt';
import { type World } from './world';
import { CHUNK_SIZE, CHUNK_VOLUME, chunkKey, WORLD_HEIGHT } from './grid';
import { registerWorldScope } from './worldScope';

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** 读块但不隐式触发未加载 chunk 生成（未加载按 AIR 处理）：加载半径边缘的红石扫描/播种不再拖动 chunk 生成 */
function getBlockLoaded(world: World, x: number, y: number, z: number): BlockId {
  if (!world.isChunkLoaded(x, z)) return AIR;
  return world.getBlock(x, y, z);
}

/** 粉网络功率图（0-15） */
const power = new Map<string, number>();
/** 电源位置登记（红石火把/开着的拉杆/红石块/on 态中继器/按下的按钮/踩中的压力板/脉冲中的侦测器与标靶） */
const sources = new Set<string>();
/** 定向电源（on 态中继器/脉冲侦测器）：位置键 → 朝向，只对输出面朝的邻位供电（MC）；其余电源全向 */
const dirSources = new Map<string, number>();
/** 弱充能的实心方块（拉杆/按钮/压力板/红石块指向；电平恒 15。激活 6 邻元件，不驱动邻接粉，不链式外传） */
const weak = new Set<string>();
/** 强充能的实心方块（火把正上方/中继器/比较器/侦测器输出指向）→ 电平。驱动邻接粉并激活 6 邻元件（MC） */
const strong = new Map<string, number>();
/** 被粉按指向弱充能的实心方块 → 粉的实际电平（激活元件，不驱动粉） */
const dustCharge = new Map<string, number>();
/** 粉弱充能的反向索引：粉格键 → 它弱充能的方块键集合（撤功率时同步撤销） */
const dustChargeBy = new Map<string, Set<string>>();
/** 粉格 → 水平指向位掩码（bit0=+x bit1=-x bit2=+z bit3=-z，见 HDIRS；recompute 重建半径内带电粉的指向） */
const pointDirs = new Map<string, number>();
/** 比较器前方格 → 输出电平（比较器激活前方元件的登记；无方块类型要求，灯/活塞直连输出面有效） */
const compFront = new Map<string, number>();
/** 元件登记表：反应扫描要处理的元件位置（火把含熄灭态/灯/门/TNT/活塞/活塞头/中继器/比较器/音符盒）。
 *  与 sources 同款 "x,y,z" 键；notifyRedstone（所有 setBlock 必经路径）增量维护 + rescanSources 对新加载 chunk 补扫，
 *  让 recompute 第 5 步只遍历登记项（半径内）而不再做 35³ 全量扫描 */
const components = new Set<string>();

const DUST = () => BLOCK_BY_KEY.redstone_dust.id;
const TORCH = () => BLOCK_BY_KEY.redstone_torch.id;
const TORCH_OFF = () => BLOCK_BY_KEY.redstone_torch_off.id;
const LEVER_ON = () => BLOCK_BY_KEY.lever_on.id;
const RS_BLOCK = () => BLOCK_BY_KEY.redstone_block.id;
const LAMP = () => BLOCK_BY_KEY.redstone_lamp.id;
const LAMP_LIT = () => BLOCK_BY_KEY.redstone_lamp_lit.id;
const TNT = () => BLOCK_BY_KEY.tnt.id;
const NOTE = () => BLOCK_BY_KEY.note_block.id;
const TARGET = () => BLOCK_BY_KEY.target.id;

const blockKeyOf = (id: BlockId): string => BLOCKS[id]?.key ?? '';

/** 按钮按下态是电源，脉冲到期回弹 */
const isButtonOnId = (id: BlockId): boolean => /^(oak|stone)_button_on$/.test(blockKeyOf(id));
/** 压力板（玩家/生物踩中由 tick 登记为电源，离开撤销） */
export const isPressurePlateId = (id: BlockId): boolean => /^(oak|stone)_pressure_plate$/.test(blockKeyOf(id));
/** 侦测器（6 朝向变体） */
export const isObserverId = (id: BlockId): boolean => blockKeyOf(id).startsWith('observer_');

/** 侦测器 id：按朝向（0-5，同活塞 facing 约定） */
export function observerIdFor(facing: number): number {
  return BLOCK_BY_KEY[`observer_${['n', 'e', 's', 'w', 'u', 'd'][facing] ?? 'n'}`].id;
}

const isRepeaterIdInternal = (id: BlockId): boolean => blockKeyOf(id).startsWith('repeater_');
export const isRepeaterId = isRepeaterIdInternal;
const isRepeaterOnId = (id: BlockId): boolean => blockKeyOf(id).startsWith('repeater_on_');

export const isComparatorId = (id: BlockId): boolean => blockKeyOf(id).startsWith('comparator_');
const isComparatorOnId = (id: BlockId): boolean => blockKeyOf(id).startsWith('comparator_on_');

/** 实心导电方块（可被强/弱充能；近似 Java 的 redstone conductor） */
const isConductor = (id: BlockId): boolean => {
  const def = BLOCKS[id];
  return !!def && def.opaque && def.solid;
};

/** 比较器输出电平 0-15（比较 = 背向输入；减法 = 背向 − max(两侧)，MC）。已结算值，延迟 1 红石刻提交 */
const compOutputs = new Map<string, number>();
/** 比较器模式：true = 减法（右键切换；默认 false 比较） */
const compSubtract = new Map<string, boolean>();

/** 右键切换比较器模式（比较 ↔ 减法，MC），返回是否减法；模式变化按 1 红石刻延迟重新结算输出 */
export function toggleComparatorMode(x: number, y: number, z: number): boolean {
  const k = key(x, y, z);
  const next = !compSubtract.get(k);
  compSubtract.set(k, next);
  scheduleCompEval(k);
  return next;
}

/** 某格信号电平：电源 15，强充能块按电平，弱充能块 15，被粉弱充能的方块读粉的实际电平，粉的当前功率，否则 0 */
function signalAt(x: number, y: number, z: number): number {
  const k = key(x, y, z);
  if (sources.has(k)) return 15;
  const s = strong.get(k);
  if (s !== undefined) return s;
  if (weak.has(k)) return 15;
  const d = dustCharge.get(k);
  if (d !== undefined) return d;
  return power.get(k) ?? 0;
}

const isSourceId = (id: BlockId): boolean => id === TORCH() || id === LEVER_ON() || id === RS_BLOCK() || isRepeaterOnId(id) || isButtonOnId(id);

/** 元件（消费端）：红石灯/门/TNT/活塞/中继器/比较器/音符盒 */
function isConsumerId(id: BlockId): boolean {
  const def = BLOCKS[id];
  if (!def) return false;
  return id === LAMP() || id === LAMP_LIT() || id === TNT() || id === NOTE() || def.shape === 'door' || isPistonId(id) || def.key === 'piston_head' || isRepeaterIdInternal(id) || isComparatorId(id);
}

/** 反应扫描关心的全部元件：红石火把（含熄灭态，反相/烧毁反应）+ 消费端 */
function isComponentId(id: BlockId): boolean {
  return id === TORCH() || id === TORCH_OFF() || isConsumerId(id);
}

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** 水平 4 向（指向位掩码的位序：bit0=+x bit1=-x bit2=+z bit3=-z） */
const HDIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** 粉的连接邻位枚举（MC Java）：同层 4 邻 + 对角上坡（本格上方实心则切断）+ 对角下坡（不被角格实心切断） */
function dustNeighbors(world: World, x: number, y: number, z: number, cb: (nx: number, ny: number, nz: number) => void): void {
  const upBlocked = isConductor(world.getBlock(x, y + 1, z));
  for (const [dx, dz] of HDIRS) {
    cb(x + dx, y, z + dz);
    if (!upBlocked) cb(x + dx, y + 1, z + dz); // 上坡：本格上方实心切断（Java 压线规则）
    cb(x + dx, y - 1, z + dz); // 下坡：角格实心不切断（Java）
  }
}

/** 粉的指向位掩码（MC Java）：有连接的方向（同层/对角上下坡的粉）；无任何连接的点状粉指水平四向。
 *  一字形只指两端——中段侧面的方块不被弱充能 */
function computePointDirs(world: World, x: number, y: number, z: number): number {
  const upBlocked = isConductor(getBlockLoaded(world, x, y + 1, z));
  let m = 0;
  for (let i = 0; i < 4; i++) {
    const [dx, dz] = HDIRS[i];
    if (getBlockLoaded(world, x + dx, y, z + dz) === DUST()) m |= 1 << i;
    else if ((!upBlocked && getBlockLoaded(world, x + dx, y + 1, z + dz) === DUST()) || getBlockLoaded(world, x + dx, y - 1, z + dz) === DUST()) m |= 1 << i;
  }
  return m === 0 ? 0b1111 : m;
}

/** 粉是否指向水平方向 (dx,dz)（无记录时按点状处理：供水平四向） */
function dustPointsTo(px: number, py: number, pz: number, dx: number, dz: number): boolean {
  const m = pointDirs.get(key(px, py, pz)) ?? 0b1111;
  for (let i = 0; i < 4; i++) if (HDIRS[i][0] === dx && HDIRS[i][1] === dz) return (m & (1 << i)) !== 0;
  return false;
}

/** 某格是否被供能（元件激活判定）：邻接电源（定向电源只对输出面朝的邻位供电）/ 邻接强或弱充能块 /
 *  带电粉（正上方的粉总供下方块；同层粉按指向供能；下方的粉不向上供）/ 本格是比较器输出前方格 */
export function poweredAt(x: number, y: number, z: number): boolean {
  if ((compFront.get(key(x, y, z)) ?? 0) > 0) return true; // 比较器输出指向本格（MC：直连输出面的元件被激活）
  for (const [dx, dy, dz] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    const k = key(nx, ny, nz);
    if (sources.has(k)) {
      const f = dirSources.get(k);
      if (f === undefined) return true; // 火把/拉杆/红石块/按钮/压力板：全向供电
      const [fx, fy, fz] = FACING_VEC[f];
      if (fx === -dx && fy === -dy && fz === -dz) return true; // 中继器/侦测器只向面朝方向输出
    }
    if (strong.has(k) || weak.has(k) || dustCharge.has(k)) return true; // 充能块激活邻接元件（MC）
    if ((power.get(k) ?? 0) > 0) {
      if (dy === 1) return true; // 正上方的粉：任何形态都供正下方块
      if (dy === 0 && dustPointsTo(nx, ny, nz, -dx, -dz)) return true; // 同层粉按指向供能
    }
  }
  return false;
}

/** 方块是否被充能（火把反相判定）：本格自身被强/弱充能（含粉按指向的弱充能）/ 本格是比较器输出前方格 /
 *  邻接电源（忽略坐在本块上的火把——火把不充能自己的支撑块，MC）/ 正上方的带电粉 / 同层指向本格的带电粉。
 *  注意与 poweredAt 不同：邻格被充能不算——充能不跨块链式传递（MC，否则粉充能正下方块会隔着一格误熄火把） */
function blockEnergized(world: World, x: number, y: number, z: number): boolean {
  const k = key(x, y, z);
  if (strong.has(k) || weak.has(k) || dustCharge.has(k)) return true;
  if ((compFront.get(k) ?? 0) > 0) return true;
  for (const [dx, dy, dz] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    const nk = key(nx, ny, nz);
    if (sources.has(nk) && !(dy === 1 && getBlockLoaded(world, nx, ny, nz) === TORCH())) {
      const f = dirSources.get(nk);
      if (f === undefined) return true;
      const [fx, fy, fz] = FACING_VEC[f];
      if (fx === -dx && fy === -dy && fz === -dz) return true;
    }
    if ((power.get(nk) ?? 0) > 0) {
      if (dy === 1) return true; // 正上方的粉：任何形态都供正下方块
      if (dy === 0 && dustPointsTo(nx, ny, nz, -dx, -dz)) return true; // 同层粉按指向供能
    }
  }
  return false;
}

/** 电源指向的强充能目标格（MC：火把→正上方块；中继器/脉冲侦测器→输出方向块） */
function strongTargetsOf(x: number, y: number, z: number, id: BlockId, k: string): [number, number, number][] {
  if (isRepeaterOnId(id) || isObserverId(id)) {
    const f = dirSources.get(k);
    if (f === undefined) return [];
    const [dx, dy, dz] = FACING_VEC[f];
    return [[x + dx, y + dy, z + dz]];
  }
  if (id === TORCH()) return [[x, y + 1, z]];
  return [];
}

/** 电源指向的弱充能目标格（MC：拉杆/按钮→6 邻（无朝向数据，按附着面泛化）；压力板→下方块；红石块→6 邻） */
function weakTargetsOf(x: number, y: number, z: number, id: BlockId): [number, number, number][] {
  if (isPressurePlateId(id)) return [[x, y - 1, z]];
  if (id === LEVER_ON() || isButtonOnId(id) || id === RS_BLOCK()) {
    return DIRS.map(([dx, dy, dz]) => [x + dx, y + dy, z + dz] as [number, number, number]);
  }
  return [];
}

/** 撤销电源登记并清掉它留下的充能指向（拉杆关断/按钮回弹/压力板松开/脉冲到期/方块被挖） */
function removeSource(x: number, y: number, z: number, k: string): void {
  sources.delete(k);
  dirSources.delete(k);
  for (const [dx, dy, dz] of DIRS) {
    weak.delete(key(x + dx, y + dy, z + dz));
    strong.delete(key(x + dx, y + dy, z + dz));
  }
}

/** 粉的当前功率（HUD/调试可用；无则 0） */
export function dustPowerAt(x: number, y: number, z: number): number {
  return power.get(key(x, y, z)) ?? 0;
}

const R = 17; // 元件反应扫描半径（粉最远传 15 格）

// ——— 红石火把烧毁（burnout，MC Java：60 游戏刻=3s 内切换 8 次烧毁熄灭，收到邻近方块更新才重燃） ———

/** 各火把近期翻转时刻（simTime 秒；3s 窗口外的不计） */
const torchFlips = new Map<string, number[]>();
/** 烧毁中的火把：输出恒断，直到收到邻近方块更新（notifyRedstone 清除） */
const burntTorches = new Set<string>();
const BURNOUT_WINDOW = 3; // 60 游戏刻 = 3s（本引擎 30 红石刻）
const BURNOUT_MAX_FLIPS = 8;

/** 记录一次火把翻转（simTime 3s 窗口内累计），返回是否因此烧毁 */
function recordTorchFlip(x: number, y: number, z: number): boolean {
  const k = key(x, y, z);
  const recent = (torchFlips.get(k) ?? []).filter((t) => simTime - t < BURNOUT_WINDOW);
  recent.push(simTime);
  if (recent.length >= BURNOUT_MAX_FLIPS) {
    torchFlips.delete(k);
    burntTorches.add(k);
    return true;
  }
  torchFlips.set(k, recent);
  return false;
}

/** 粘性活塞供电起始时刻（simTime 秒）：断供时据此判定 1-tick 短脉冲（≤1 红石刻收回不拉回方块，MC Java） */
const pistonOnAt = new Map<string, number>();

let applying = false; // 反应回写防重入

/** 以 (cx,cy,cz) 为中心局部重算粉网络并应用元件反应 */
function recompute(world: World, cx: number, cy: number, cz: number): void {
  if (applying) return;
  const inRange = (x: number, y: number, z: number): boolean => Math.abs(x - cx) <= R && Math.abs(y - cy) <= R && Math.abs(z - cz) <= R;
  // 1. 清旧功率：以半径内带电格与变动点邻域为入口，沿粉连通域（含对角上下坡）BFS 清除（不设半径）。
  //    链路超出 R 的远端也清得到；贴着被清网络的远端电源在下一步补种恢复——
  //    清除与播种覆盖同一连通域，长链路既不留幽灵功率，也不会误清远端活功率。
  const cleared = new Set<string>();
  const flood: [number, number, number][] = [];
  const pushCell = (x: number, y: number, z: number): void => {
    const k = key(x, y, z);
    if (cleared.has(k)) return;
    if (!world.isChunkLoaded(x, z)) return; // 未加载不读块（防隐式生成）；残留功率登记随 chunk 重载后的重算清理
    if (world.getBlock(x, y, z) !== DUST() && !power.has(k)) return; // 粉格，或曾带电的粉格（方块刚被改动）
    cleared.add(k);
    flood.push([x, y, z]);
  };
  for (const k of [...power.keys()]) {
    const [x, y, z] = k.split(',').map(Number);
    if (inRange(x, y, z)) pushCell(x, y, z);
  }
  pushCell(cx, cy, cz);
  for (const [dx, dy, dz] of DIRS) pushCell(cx + dx, cy + dy, cz + dz);
  while (flood.length > 0) {
    const [x, y, z] = flood.pop()!;
    const k = key(x, y, z);
    power.delete(k);
    // 该粉格产生的弱充能一并撤销
    const charged = dustChargeBy.get(k);
    if (charged) {
      for (const bk of charged) dustCharge.delete(bk);
      dustChargeBy.delete(k);
    }
    dustNeighbors(world, x, y, z, (nx, ny, nz) => pushCell(nx, ny, nz));
  }
  /** 与被清连通域相邻（半径外但贴着被清网络的电源/比较器也要补种） */
  const touchesCleared = (x: number, y: number, z: number): boolean => {
    for (const [dx, dy, dz] of DIRS) if (cleared.has(key(x + dx, y + dy, z + dz))) return true;
    return false;
  };
  // 2. 电源播种：半径内电源 + 贴着被清网络的半径外电源；邻格粉从 15 起（MC：电源供能邻接粉 15 级）。
  //    同时重建强/弱充能指向（撤销侧的清理见 removeSource / notifyRedstone）
  const queue: [number, number, number, number][] = [];
  const trySet = (x: number, y: number, z: number, level: number): void => {
    if (!world.isChunkLoaded(x, z)) return; // 边缘播种不越界（防隐式生成）
    if (world.getBlock(x, y, z) !== DUST()) return;
    const k = key(x, y, z);
    if ((power.get(k) ?? 0) >= level) return;
    power.set(k, level);
    if (level > 1) queue.push([x, y, z, level]);
  };
  for (const k of sources) {
    const [x, y, z] = k.split(',').map(Number);
    if (!inRange(x, y, z) && !touchesCleared(x, y, z)) continue;
    if (!world.isChunkLoaded(x, z)) continue; // 未加载电源：不读块（防隐式生成），登记保留
    const id = world.getBlock(x, y, z);
    // 强充能：火把正上方块、中继器/脉冲侦测器输出方向的实心方块（驱动邻接粉与元件，MC）
    for (const [wx, wy, wz] of strongTargetsOf(x, y, z, id, k)) {
      if (isConductor(getBlockLoaded(world, wx, wy, wz))) strong.set(key(wx, wy, wz), 15);
    }
    // 弱充能：拉杆/按钮/压力板/红石块指向的实心方块（只激活元件，不驱动粉，MC）
    for (const [wx, wy, wz] of weakTargetsOf(x, y, z, id)) {
      if (isConductor(getBlockLoaded(world, wx, wy, wz))) weak.add(key(wx, wy, wz));
    }
    if (isRepeaterOnId(id)) {
      // 中继器：只向输出方向（front）供能 15 级（信号再生，MC 核心特性）；
      // 前格与其顶面都播种（MC 粉铺在方块顶面，等价于前方方块被供能）
      const f = BLOCKS[id].facing ?? 0;
      const [dx, dy, dz] = FACING_VEC[f];
      trySet(x + dx, y + dy, z + dz, 15);
      trySet(x + dx, y + dy + 1, z + dz, 15);
    } else if (isObserverId(id) && dirSources.has(k)) {
      // 侦测器脉冲：只向背面输出 15（MC 定向）
      const [dx, dy, dz] = FACING_VEC[dirSources.get(k)!];
      trySet(x + dx, y + dy, z + dz, 15);
      trySet(x + dx, y + dy + 1, z + dz, 15);
    } else {
      for (const [dx, dy, dz] of DIRS) trySet(x + dx, y + dy, z + dz, 15);
    }
  }
  // 比较器已结算输出：前方粉按电平播种 + 前方实心块强充能 + compFront 登记（输出延迟 1 红石刻在 tickRedstone 提交）
  for (const [k, out] of compOutputs) {
    const [x, y, z] = k.split(',').map(Number);
    if (!inRange(x, y, z) && !touchesCleared(x, y, z)) continue;
    if (!world.isChunkLoaded(x, z)) continue; // 未加载比较器：不读块（防隐式生成），登记保留
    const id = world.getBlock(x, y, z);
    if (!isComparatorId(id)) continue;
    const f = BLOCKS[id].facing ?? 0;
    const [dx, dy, dz] = FACING_VEC[f];
    const fk = key(x + dx, y + dy, z + dz);
    if (out > 0) {
      trySet(x + dx, y + dy, z + dz, out);
      trySet(x + dx, y + dy + 1, z + dz, out);
      compFront.set(fk, out);
      if (isConductor(getBlockLoaded(world, x + dx, y + dy, z + dz))) strong.set(fk, out);
    } else {
      compFront.delete(fk);
      strong.delete(fk);
    }
  }
  // 强充能块按电平播种邻接粉（MC：强充能块驱动粉；弱充能块不驱动——拉杆→方块→粉 不导通）
  for (const [k, lvl] of strong) {
    const [x, y, z] = k.split(',').map(Number);
    if (!inRange(x, y, z) && !touchesCleared(x, y, z)) continue;
    for (const [dx, dy, dz] of DIRS) trySet(x + dx, y + dy, z + dz, lvl);
  }
  // 3. BFS 衰减传播（沿粉的连接形态：同层 4 邻 + 对角上下坡，每步衰减 1 级）
  while (queue.length > 0) {
    const [x, y, z, level] = queue.shift()!;
    dustNeighbors(world, x, y, z, (nx, ny, nz) => trySet(nx, ny, nz, level - 1));
  }
  // 4. 重建半径内带电粉的指向形态与粉弱充能（供能反应与比较器读数依赖；任何形态都弱充能正下方块、不供正上方）
  for (const dustK of [...dustChargeBy.keys()]) {
    const [x, y, z] = dustK.split(',').map(Number);
    if (!inRange(x, y, z)) continue;
    for (const bk of dustChargeBy.get(dustK)!) dustCharge.delete(bk);
    dustChargeBy.delete(dustK);
  }
  for (const [k, lvl] of power) {
    if (lvl <= 0) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (!inRange(x, y, z)) continue;
    if (!world.isChunkLoaded(x, z)) continue; // 未加载粉格：不重建指向（防隐式生成），功率登记保留
    const m = computePointDirs(world, x, y, z);
    pointDirs.set(k, m);
    const charged = new Set<string>();
    for (let i = 0; i < 4; i++) {
      if ((m & (1 << i)) === 0) continue;
      const [dx, dz] = HDIRS[i];
      if (!isConductor(getBlockLoaded(world, x + dx, y, z + dz))) continue;
      const bk = key(x + dx, y, z + dz);
      if ((dustCharge.get(bk) ?? 0) < lvl) dustCharge.set(bk, lvl);
      charged.add(bk);
    }
    if (isConductor(getBlockLoaded(world, x, y - 1, z))) {
      const bk = key(x, y - 1, z);
      if ((dustCharge.get(bk) ?? 0) < lvl) dustCharge.set(bk, lvl);
      charged.add(bk);
    }
    if (charged.size > 0) dustChargeBy.set(k, charged);
  }
  // 5. 半径内元件反应（先收集再回写，避免边算边改）。
  //    登记表驱动：只遍历「登记表中落在半径内的元件」+「变动格与其 6 邻的活读补漏」
  //    （补漏针对登记未覆盖的情形，如直写 data 未重扫的 chunk），不再做 35³ 全量扫描；
  //    未加载 chunk 的登记项跳过且不读块（getBlock 会隐式触发全量生成）。
  //    收集后按旧 35³ 扫描的逐点顺序排序（x 外层、y 中层、z 内层），反应收集/回写次序不变
  const reacts: (() => void)[] = [];
  let torchChanged = false; // 火把反相翻转需安排结算重播（等价 MC 的火把延迟）
  const scanCells: [number, number, number][] = [];
  const seenCells = new Set<string>();
  for (const k of components) {
    const [x, y, z] = k.split(',').map(Number);
    if (Math.abs(x - cx) > R || Math.abs(y - cy) > R || Math.abs(z - cz) > R) continue;
    if (!world.isChunkLoaded(x, z)) continue;
    seenCells.add(k);
    scanCells.push([x, y, z]);
  }
  for (let d = -1; d < DIRS.length; d++) {
    const [dx, dy, dz] = d < 0 ? [0, 0, 0] : DIRS[d];
    const nx = cx + dx;
    const ny = cy + dy;
    const nz = cz + dz;
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    const nk = key(nx, ny, nz);
    if (seenCells.has(nk) || !world.isChunkLoaded(nx, nz)) continue;
    if (!isComponentId(world.getBlock(nx, ny, nz))) continue;
    seenCells.add(nk);
    scanCells.push([nx, ny, nz]);
  }
  scanCells.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [x, y, z] of scanCells) {
    const id = world.getBlock(x, y, z);
    // 红石火把反相（NOT 门）：下方附着块被充能则熄灭，失去充能复亮；
    // 烧毁（MC Java：3s 内切换 8 次）则恒灭，直到收到邻近方块更新（notifyRedstone 清除烧毁态）
    if (id === TORCH() || id === TORCH_OFF()) {
      const k = key(x, y, z);
      if (burntTorches.has(k)) {
        if (id === TORCH()) {
          reacts.push(() => world.setBlock(x, y, z, TORCH_OFF())); // 烧毁态保底恒灭
          torchChanged = true;
        }
        continue;
      }
      if (id === TORCH() && blockEnergized(world, x, y - 1, z)) {
        recordTorchFlip(x, y, z); // 计入翻转；达阈值登记烧毁（本次照常熄灭）
        reacts.push(() => world.setBlock(x, y, z, TORCH_OFF()));
        torchChanged = true;
      } else if (id === TORCH_OFF() && !blockEnergized(world, x, y - 1, z)) {
        if (!recordTorchFlip(x, y, z)) {
          reacts.push(() => world.setBlock(x, y, z, TORCH()));
          torchChanged = true;
        }
        // 烧毁：本次不点亮（烧毁集已登记，后续走上方恒灭分支）
      }
      continue;
    }
    if (!isConsumerId(id)) {
      components.delete(key(x, y, z)); // 失效登记自检除名（直写 data 替换等非常规路径）
      continue;
    }
    const on = poweredAt(x, y, z);
    if (id === LAMP() && on) reacts.push(() => world.setBlock(x, y, z, LAMP_LIT()));
    else if (id === LAMP_LIT() && !on) reacts.push(() => world.setBlock(x, y, z, LAMP()));
    else if (id === TNT() && on) {
      reacts.push(() => {
        world.setBlock(x, y, z, AIR);
        igniteTnt(x, y, z);
      });
    } else if (id === NOTE()) {
      // 音符盒：充能上升沿发声（音高按右击调音记录，默认 0 = C4）
      const k = key(x, y, z);
      const prev = noteStates.get(k) ?? false;
      noteStates.set(k, on);
      if (on && !prev) {
        const semi = notePitches.get(k) ?? 0;
        reacts.push(() => noteBlock(semi));
      }
    } else if (isPistonId(id)) {
      // 活塞：供能推出、断能收回（粘性拉回）。
      // QC 半连接性（MC Java）：上方一格 (x,y+1,z) 按门位置做供电判定；QC 供能时只在收到
      // 邻近方块更新（本次重算的变动格与活塞 6 邻接，含活塞自身被放置）才动作（BUD 态），常规供电即时动作
      const k = key(x, y, z);
      const qc = poweredAt(x, y + 1, z);
      const updated = Math.abs(x - cx) + Math.abs(y - cy) + Math.abs(z - cz) <= 1;
      if ((on || qc) && !isExtended(world, x, y, z)) {
        if (on || updated) {
          pistonOnAt.set(k, simTime);
          reacts.push(() => {
            tryExtend(world, x, y, z);
            // 推出失败（行堵/超 12 块上限）：回滚供电起始记录，防条目泄漏
            if (!isExtended(world, x, y, z)) pistonOnAt.delete(k);
          });
        }
      } else if (!on && !qc && isExtended(world, x, y, z)) {
        // 粘性活塞 1-tick 短脉冲：供电时长 ≤1 红石刻（0.1s，+0.05s 帧调度裕量）时收回不拉回方块（MC Java）；
        // 同一时刻内供断（delta=0，如同帧拉杆开关）不算短脉冲，正常拉回
        const started = pistonOnAt.get(k);
        pistonOnAt.delete(k);
        const shortPulse = isStickyPistonId(id) && started !== undefined && started < simTime && simTime - started <= 0.15;
        reacts.push(() => retract(world, x, y, z, shortPulse));
      }
    } else if (isRepeaterIdInternal(id)) {
      // 中继器：输入（背向）状态变化 → 按延迟档调度翻转（tickRedstone 结算）；
      // 侧向锁存（MC）：被另一充能中继器/比较器从侧面指向时锁定，输出保持、撤销待结算翻转
      const f = BLOCKS[id].facing ?? 0;
      const [dx, , dz] = FACING_VEC[f];
      if (repeaterLocked(world, x, y, z, f)) {
        const idx = pendingFlips.findIndex((fl) => fl.key === key(x, y, z));
        if (idx >= 0) pendingFlips.splice(idx, 1);
      } else if (inputAt(world, x, y, z, dx, dz) !== isRepeaterOnId(id)) {
        scheduleFlip(x, y, z);
      }
    } else if (isComparatorId(id)) {
      // 比较器：输入变化 → 调度 1 红石刻后结算（MC 延迟；tickRedstone 到期按实时输入提交，去抖）
      const out = computeCompOut(world, x, y, z);
      if (out !== (compOutputs.get(key(x, y, z)) ?? 0)) scheduleCompEval(key(x, y, z));
    } else if (BLOCKS[id]?.key === 'piston_head') {
      // 孤儿活塞头：背向无活塞自动消失
      reacts.push(() => cleanupOrphanHeads(world, x, y, z));
    } else {
      const def = BLOCKS[id];
      if (def?.shape === 'door') {
        // 门：供能开、断能合（上下两格同步；注册序每朝向 [bottom, top, open_bottom, open_top]）
        const f = def.facing!;
        const baseId = BLOCK_BY_KEY.oak_door_bottom_n.id + f * 4;
        const wantOpen = on;
        if (def.doorOpen !== wantOpen) {
          const bottomY = def.doorHalf === 'top' ? y - 1 : y;
          reacts.push(() => {
            world.setBlock(x, bottomY, z, baseId + (wantOpen ? 2 : 0));
            world.setBlock(x, bottomY + 1, z, baseId + (wantOpen ? 3 : 1));
          });
        }
      }
    }
  }
  if (reacts.length > 0) {
    applying = true;
    try {
      for (const fn of reacts) fn();
    } finally {
      applying = false;
    }
  }
  if (torchChanged) {
    // 火把反相翻转：安排结算重播让下游元件按新状态刷新（等价 MC 的 1 tick 评估）
    pendingRecompute = [cx, cy, cz];
  }
}

/** world.setBlock 钩子：电源登记 + 粉/电源/元件变动触发局部重算 */
export function notifyRedstone(world: World, x: number, y: number, z: number, oldId: BlockId, newId: BlockId): void {
  if (oldId === newId) return;
  const k = key(x, y, z);
  // 元件登记表增量维护（本格进出元件；反应回写的 setBlock 也走这里，登记必须先于 applying 早退）
  if (isComponentId(oldId)) components.delete(k);
  if (isComponentId(newId)) components.add(k);
  const wasSource = sources.has(k); // 含压力板/侦测器/标靶等临时电源
  if (isSourceId(oldId) || wasSource) removeSource(x, y, z, k);
  weak.delete(k); // 本格曾弱充能：方块已变，指向失效
  strong.delete(k); // 本格曾强充能：同上
  dustCharge.delete(k); // 本格曾被粉弱充能：同上
  activePlates.delete(k);
  if (isObserverId(oldId)) observers.delete(k);
  if ((oldId === TORCH() || oldId === TORCH_OFF()) && newId !== TORCH() && newId !== TORCH_OFF()) {
    // 火把被挖/推走：清掉翻转记录与烧毁态（ON↔OFF 同族翻转保留记录——那是反相/烧毁自身的翻转）
    torchFlips.delete(k);
    burntTorches.delete(k);
  }
  // 烧毁的火把收到邻近方块更新：清除烧毁态，下次重算可重燃（MC Java）。
  // 火把同族翻转（TORCH↔TORCH_OFF）不算更新——否则烧毁瞬间就被自己的熄灭翻转清掉了
  let unburnt = false;
  if (oldId !== TORCH() && oldId !== TORCH_OFF() && newId !== TORCH() && newId !== TORCH_OFF()) {
    for (const [dx, dy, dz] of DIRS) if (burntTorches.delete(key(x + dx, y + dy, z + dz))) unburnt = true;
  }
  if (isComparatorId(oldId) && !isComparatorId(newId)) {
    // 比较器被挖/推走：清掉输出登记与前方供能指向（on/off 同族翻转不清——compOutputs 由结算路径维护）
    compOutputs.delete(k);
    compSubtract.delete(k);
    const f = BLOCKS[oldId].facing ?? 0;
    const [dx, dy, dz] = FACING_VEC[f];
    compFront.delete(key(x + dx, y + dy, z + dz));
    strong.delete(key(x + dx, y + dy, z + dz));
  }
  if (oldId === NOTE()) {
    noteStates.delete(k);
    notePitches.delete(k);
  }
  if (isSourceId(newId)) {
    sources.add(k);
    // on 态中继器是定向电源（只向输出面朝的邻位供电），其余电源全向
    if (isRepeaterOnId(newId)) dirSources.set(k, BLOCKS[newId].facing ?? 0);
  }
  if (isObserverId(newId)) {
    // 登记侦测器并记录面朝格初始状态签名：放置本身不触发脉冲（MC Java）
    const f = BLOCKS[newId].facing ?? 0;
    const [dx, dy, dz] = FACING_VEC[f];
    observers.set(k, obsSignature(world, x + dx, y + dy, z + dz));
  }
  if (applying) return; // 反应回写不再触发（状态已是目标态）
  // 触发重算：电源/粉/元件变动；或容器变动（比较器可能正测它的装满度，MC Java 容器发方块更新）；
  // 或本格贴着电源（实心块进出可能改变充能指向）；
  // 或本格贴着粉（实心块进出可能改变粉的爬坡切断/连接形态与弱充能指向）；
  // 或本格贴着活塞（方块更新可能触发 QC/BUD 激活，MC Java；未加载 chunk 方向跳过，不隐式生成）
  const nearSource = DIRS.some(([dx, dy, dz]) => sources.has(key(x + dx, y + dy, z + dz)));
  const nearDust = DIRS.some(([dx, dy, dz]) => {
    const nx = x + dx;
    const nz = z + dz;
    if (!world.chunks.has(chunkKey(nx >> 4, nz >> 4))) return false;
    return world.getBlock(nx, y + dy, nz) === DUST() || power.has(key(nx, y + dy, nz));
  });
  const nearPiston = DIRS.some(([dx, dy, dz]) => {
    const nx = x + dx;
    const nz = z + dz;
    if (!world.chunks.has(chunkKey(nx >> 4, nz >> 4))) return false;
    return isPistonId(world.getBlock(nx, y + dy, nz));
  });
  if (
    isSourceId(oldId) ||
    isSourceId(newId) ||
    wasSource ||
    oldId === DUST() ||
    newId === DUST() ||
    isConsumerId(oldId) ||
    isConsumerId(newId) ||
    isContainerId(oldId) ||
    isContainerId(newId) ||
    unburnt || // 烧毁火把被邻近更新解除：重算让它按当前充能态重燃
    nearSource ||
    nearDust ||
    nearPiston
  ) {
    recompute(world, x, y, z);
  }
}

/** 拉杆右击切换（actions 调用）：返回切换后是否开着 */
export function toggleLever(world: World, x: number, y: number, z: number): boolean {
  const id = world.getBlock(x, y, z);
  const on = id === LEVER_ON();
  if (id !== LEVER_ON() && id !== BLOCK_BY_KEY.lever.id) return false;
  world.setBlock(x, y, z, on ? BLOCK_BY_KEY.lever.id : LEVER_ON());
  return !on;
}

/** 右击按钮（actions 调用）：按下供电，石头 1s / 木质 1.5s 后回弹（MC）；
 *  已按下时忽略（MC 按住不重复触发）。返回是否按下成功 */
export function pressButton(world: World, x: number, y: number, z: number): boolean {
  const bk = blockKeyOf(world.getBlock(x, y, z));
  if (bk !== 'oak_button' && bk !== 'stone_button') return false;
  world.setBlock(x, y, z, BLOCK_BY_KEY[`${bk}_on`].id);
  pendingPulses.push({ key: key(x, y, z), at: simTime + (bk === 'stone_button' ? 1 : 1.5), kind: 'button' });
  return true;
}

/** 标靶被弹射物命中（箭矢撞块处调用）：全向 15 脉冲 1s（MC 按命中偏移 1-15 级 ×1s，简化为满级） */
export function strikeTarget(world: World, x: number, y: number, z: number): boolean {
  if (world.getBlock(x, y, z) !== TARGET()) return false;
  const k = key(x, y, z);
  const existing = pendingPulses.find((p) => p.key === k && p.kind === 'target');
  if (existing) existing.at = simTime + 1; // 重复命中：刷新时长（供电不中断）
  else pendingPulses.push({ key: k, at: simTime + 1, kind: 'target' });
  if (!sources.has(k)) {
    sources.add(k);
    recompute(world, x, y, z);
  }
  return true;
}

/** 右击音符盒调音（actions 调用）：升半音，0-23 循环（MC 24 半音），并发声试听；返回新半音数 */
export function tuneNoteBlock(x: number, y: number, z: number): number {
  const k = key(x, y, z);
  const next = ((notePitches.get(k) ?? 0) + 1) % 24;
  notePitches.set(k, next);
  noteBlock(next);
  return next;
}

/** 音符盒当前音高（半音 0-23，默认 0 = C4） */
export function notePitchAt(x: number, y: number, z: number): number {
  return notePitches.get(key(x, y, z)) ?? 0;
}

/** 切换世界时清空供能状态 */
export function clearRedstone(): void {
  power.clear();
  sources.clear();
  dirSources.clear();
  weak.clear();
  strong.clear();
  dustCharge.clear();
  dustChargeBy.clear();
  pointDirs.clear();
  compFront.clear();
  components.clear();
  scannedChunks.clear();
  pendingFlips.length = 0;
  delays.clear();
  compOutputs.clear();
  compSubtract.clear();
  pendingCompFlips.length = 0;
  pendingRecompute = null;
  pendingPulses.length = 0;
  observers.clear();
  pendingObserverStarts.length = 0;
  pushedObservers.clear();
  activePlates.clear();
  noteStates.clear();
  notePitches.clear();
  pistonOnAt.clear();
  torchFlips.clear();
  burntTorches.clear();
}

// ——— 电源重扫：换维度/读档后从已加载 chunk 重建登记表 ———

/** blockId 标志表：bit0 电源、bit1 侦测器、bit2 反应元件。首次重扫时建一次，
 *  rescanSources 内层 32,768 格从逐格 startsWith/正则降为两次数组读取 */
const FLAG_SOURCE = 1;
const FLAG_OBSERVER = 2;
const FLAG_COMPONENT = 4;
let blockFlagTable: Uint8Array | null = null;
function blockFlags(): Uint8Array {
  if (blockFlagTable) return blockFlagTable;
  const t = new Uint8Array(BLOCKS.length);
  for (let id = 0; id < BLOCKS.length; id++) {
    let f = 0;
    if (isSourceId(id)) f |= FLAG_SOURCE;
    if (isObserverId(id)) f |= FLAG_OBSERVER;
    if (isComponentId(id)) f |= FLAG_COMPONENT;
    t[id] = f;
  }
  blockFlagTable = t;
  return t;
}

/** 已扫过的 chunk（按 key；chunk 卸载重载后数据与扫描时一致，无需重扫） */
const scannedChunks = new Set<string>();

/**
 * 换维度/读档后重建登记：遍历已加载 chunk 找出电源方块（红石火把/开着的拉杆/红石块/on 态中继器）、
 * 反应元件（登记表，recompute 第 5 步的扫描入口），并对新发现的电源做局部重算恢复供能（灯亮、粉带电）。
 * 逐帧调用安全：只扫新加载的 chunk（增量）；内层经 blockFlags 标志表两次数组读取判定，不做逐格字符串匹配。
 * 同时重新登记侦测器（记录面朝格现状签名，不因读档误触发）与按下态按钮（不持久，读档后 1s 回弹）。
 * 注：后台惰性补齐的存档 chunk 若替换了已扫 chunk 的数据（applySavedChunk）可能漏扫，该 chunk 卸载重载后自动补扫。
 */
export function rescanSources(world: World): void {
  const found: [number, number, number][] = [];
  const flags = blockFlags();
  for (const chunk of world.chunks.values()) {
    const ck = chunkKey(chunk.cx, chunk.cz);
    if (scannedChunks.has(ck)) continue;
    scannedChunks.add(ck);
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const id = chunk.data[i] as BlockId;
      const fl = flags[id];
      if (fl === 0) continue;
      const x = baseX + (i % CHUNK_SIZE);
      const y = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE));
      const z = baseZ + (Math.floor(i / CHUNK_SIZE) % CHUNK_SIZE);
      const k = key(x, y, z);
      if ((fl & FLAG_COMPONENT) !== 0) components.add(k);
      if ((fl & FLAG_OBSERVER) !== 0) {
        // 侦测器：记录面朝格现状签名（读档不触发脉冲，MC Java 放置/加载不触发）
        const f = BLOCKS[id].facing ?? 0;
        const [dx, dy, dz] = FACING_VEC[f];
        observers.set(k, obsSignature(world, x + dx, y + dy, z + dz));
        continue;
      }
      if ((fl & FLAG_SOURCE) === 0) continue;
      sources.add(k);
      if (isRepeaterOnId(id)) dirSources.set(k, BLOCKS[id].facing ?? 0);
      if (isButtonOnId(id)) pendingPulses.push({ key: k, at: simTime + 1, kind: 'button' });
      found.push([x, y, z]);
    }
  }
  // 新发现的电源：局部重算让粉网络与元件恢复供能（按 R 去重，避免成片电源反复重算）
  const done: [number, number, number][] = [];
  for (const [x, y, z] of found) {
    if (done.some(([px, py, pz]) => Math.abs(px - x) <= R && Math.abs(py - y) <= R && Math.abs(pz - z) <= R)) continue;
    done.push([x, y, z]);
    recompute(world, x, y, z);
  }
}

/** 火把反相翻转后的结算重播位置（tickRedstone 消费） */
let pendingRecompute: [number, number, number] | null = null;

// ——— 红石中继器：延迟档与延迟翻转队列 ———

/** 各中继器的延迟档（1-4 档 × 0.1s；默认 1 档，MC 一致） */
const delays = new Map<string, number>();

/** 右键调档：1→2→3→4→1（MC），返回新档位数 */
export function cycleRepeaterDelay(x: number, y: number, z: number): number {
  const k = key(x, y, z);
  const next = ((delays.get(k) ?? 1) % 4) + 1;
  delays.set(k, next);
  return next;
}

interface Flip {
  key: string;
  at: number;
}

const pendingFlips: Flip[] = [];
let simTime = 0;

function scheduleFlip(x: number, y: number, z: number): void {
  const k = key(x, y, z);
  const at = simTime + (delays.get(k) ?? 1) * 0.1;
  const existing = pendingFlips.find((f) => f.key === k);
  if (existing) {
    existing.at = at; // 以最新一次输入变化为准
    return;
  }
  pendingFlips.push({ key: k, at });
}

/** 中继器侧向锁存（MC Java）：另一充能中继器/比较器从侧面指向本中继器 → 锁定，输出保持当前状态 */
function repeaterLocked(world: World, x: number, y: number, z: number, f: number): boolean {
  const [sx, sz] = f === 0 || f === 2 ? [1, 0] : [0, 1]; // 两侧方向（垂直于朝向）
  for (const [dx, dz] of [
    [sx, sz],
    [-sx, -sz],
  ] as const) {
    const nid = getBlockLoaded(world, x + dx, y, z + dz);
    if (!isRepeaterOnId(nid) && !isComparatorOnId(nid)) continue; // 须是充能态中继器/比较器
    const nf = BLOCKS[nid].facing ?? 0;
    const [fx, , fz] = FACING_VEC[nf];
    if (fx === -dx && fz === -dz) return true; // 侧邻输出指向本中继器
  }
  return false;
}

/** 背向输入判定（中继器通电与否）：背格是电源（定向电源须朝向本格）/ 充能块 / 带电粉 / 指向本格的比较器输出 */
function inputAt(world: World, x: number, y: number, z: number, dx: number, dz: number): boolean {
  const bk = key(x - dx, y, z - dz);
  if (sources.has(bk)) {
    const f = dirSources.get(bk);
    if (f === undefined) return true;
    const [fx, , fz] = FACING_VEC[f];
    if (fx === dx && fz === dz) return true;
  }
  if (strong.has(bk) || weak.has(bk) || dustCharge.has(bk)) return true;
  if ((power.get(bk) ?? 0) > 0) return true; // 背格粉（Java 粉自动指向中继器背向）
  const bid = getBlockLoaded(world, x - dx, y, z - dz);
  if (isComparatorId(bid) && (compOutputs.get(bk) ?? 0) > 0) {
    const cf = BLOCKS[bid].facing ?? 0;
    const [fx, , fz] = FACING_VEC[cf];
    if (fx === dx && fz === dz) return true; // 比较器直连输出进背向（MC）
  }
  return false;
}

// ——— 红石比较器：1 红石刻（0.1s）输入→输出延迟 ———

interface CompFlip {
  key: string;
  at: number;
}

/** 待结算的比较器（输入变化时调度，到期按实时输入提交——去抖，等价 MC 的 1 tick 评估） */
const pendingCompFlips: CompFlip[] = [];

function scheduleCompEval(k: string): void {
  if (pendingCompFlips.some((f) => f.key === k)) return; // 已调度：不重复排队
  pendingCompFlips.push({ key: k, at: simTime + 0.1 });
}

/** 比较器实时应输出电平：比较（背向 ≥ 两侧 → 背向电平）/ 减法（背向 − max(两侧)，MC）。
 *  背向紧贴容器时以装满度为后侧输入（MC Java），接入既有比较/减法逻辑 */
function computeCompOut(world: World, x: number, y: number, z: number): number {
  const id = world.getBlock(x, y, z);
  const f = BLOCKS[id].facing ?? 0;
  const [dx, , dz] = FACING_VEC[f];
  const back = containerSignalAt(world, x - dx, y, z - dz) ?? signalAt(x - dx, y, z - dz);
  const [sx, sz] = f === 0 || f === 2 ? [1, 0] : [0, 1]; // 两侧方向（垂直于朝向）
  const side = Math.max(signalAt(x + sx, y, z + sz), signalAt(x - sx, y, z - sz));
  return compSubtract.get(key(x, y, z)) ? Math.max(back - side, 0) : back >= side ? back : 0;
}

// ——— 比较器容器检测（MC Java：背向紧贴容器时按装满度输出 0-15） ———

/** 容器方块（比较器可测：箱子/木桶 27 格、熔炉 3 槽、酿造台 5 槽） */
const isContainerId = (id: BlockId): boolean => {
  const bk = blockKeyOf(id);
  return bk === 'chest' || bk === 'barrel' || bk === 'furnace' || bk === 'brewing_stand';
};

/** 装满度公式（MC Java）：空容器 0，否则 1 + floor(Σ(槽内数量/该物品最大堆叠) / 槽位数 × 14) */
function fullnessSignal(sum: number, slotCount: number): number {
  if (sum <= 0) return 0;
  return Math.min(15, 1 + Math.floor((sum / slotCount) * 14));
}

/** 容器的装满度信号 0-15；不是容器返回 null（MC Java：容器满度取代后侧红石信号）。
 *  槽内最大堆叠：方块/材料 STACK_MAX(64)，工具/装备不可堆叠按 1（本项目无 16 堆叠物品） */
function containerSignalAt(world: World, x: number, y: number, z: number): number | null {
  const bk = blockKeyOf(getBlockLoaded(world, x, y, z));
  const k = key(x, y, z);
  if (bk === 'chest' || bk === 'barrel') {
    const slots = storages.get(k);
    if (!slots) return 0;
    let sum = 0;
    for (const s of slots) {
      if (!s) continue;
      sum += s.kind === 'block' || s.kind === 'material' ? s.count / STACK_MAX : 1; // 工具/装备：1/1
    }
    return fullnessSignal(sum, slots.length);
  }
  if (bk === 'furnace') {
    const f = furnaces.get(k);
    if (!f) return 0;
    const sum = ((f.input?.count ?? 0) + (f.fuel?.count ?? 0) + (f.output?.count ?? 0)) / STACK_MAX;
    return fullnessSignal(sum, 3); // 输入/燃料/输出 3 槽（MC）
  }
  if (bk === 'brewing_stand') {
    const b = brews.get(k);
    if (!b) return 0;
    // MC Java 1.9+：酿造台 5 槽（3 药水槽不可堆叠按 1/1 + 材料槽 + 燃料槽按 64 堆叠）
    const sum = ((b.ingredient?.count ?? 0) + (b.fuel?.count ?? 0)) / STACK_MAX + b.potions.reduce((acc, p) => acc + (p ? 1 : 0), 0);
    return fullnessSignal(sum, 5);
  }
  return null;
}

// ——— 脉冲（按钮回弹 / 侦测器与标靶的定时断电） ———

interface Pulse {
  key: string;
  at: number;
  kind: 'button' | 'observer' | 'target';
}

const pendingPulses: Pulse[] = [];

// ——— 压力板：踩中供电（玩家与生物，MC；信号 15） ———

/** 踩中的压力板位置（作为临时电源登记在 sources） */
const activePlates = new Set<string>();

/** tickPlates 帧内复用的「本帧踩中」集合（每 tick clear，避免每帧 new Set） */
const stoodScratch = new Set<string>();
/** tickPlates 帧内复用的待撤销键列表（遍历时不改 activePlates，语义与原 [...activePlates] 快照等价） */
const plateReleaseScratch: string[] = [];

/** 每 tick：比对玩家/生物脚下格与压力板，踩中登记供电、离开撤销 */
function tickPlates(world: World): void {
  const stood = stoodScratch;
  stood.clear();
  const check = (ex: number, ey: number, ez: number): void => {
    const bx = Math.floor(ex);
    const by = Math.floor(ey);
    const bz = Math.floor(ez);
    if (isPressurePlateId(world.getBlock(bx, by, bz))) stood.add(key(bx, by, bz));
  };
  check(playerPosition.x, playerPosition.y, playerPosition.z);
  for (const m of mobs) check(m.x, m.y, m.z);
  for (const k of stood) {
    if (activePlates.has(k)) continue;
    activePlates.add(k);
    sources.add(k);
    const [x, y, z] = k.split(',').map(Number);
    recompute(world, x, y, z);
  }
  plateReleaseScratch.length = 0;
  for (const k of activePlates) {
    if (!stood.has(k)) plateReleaseScratch.push(k);
  }
  for (const k of plateReleaseScratch) {
    activePlates.delete(k);
    const [x, y, z] = k.split(',').map(Number);
    removeSource(x, y, z, k);
    recompute(world, x, y, z);
  }
}

// ——— 侦测器：检测面朝方向方块状态变化，延迟 1 红石刻从背面发 1 红石刻脉冲（MC Java） ———

/** 已登记的侦测器：位置键 → 面朝格上次记录的状态签名（tick 比对变化触发脉冲） */
const observers = new Map<string, string>();

/** 侦测器面朝格的状态签名（MC Java 侦测器检测方块状态而非仅 id）：方块 id + 粉功率 / 中继器档位 / 比较器模式与输出电平 */
function obsSignature(world: World, x: number, y: number, z: number): string {
  const id = getBlockLoaded(world, x, y, z); // 贴边侦测器的面朝格可能在未加载 chunk：按 AIR，不隐式生成
  const k = key(x, y, z);
  if (id === DUST()) return `${id}:${power.get(k) ?? 0}`;
  if (isRepeaterIdInternal(id)) return `${id}:${delays.get(k) ?? 1}`;
  if (isComparatorId(id)) return `${id}:${compSubtract.get(k) ? 1 : 0}:${compOutputs.get(k) ?? 0}`;
  return `${id}`;
}

/** 朝向取反（n↔s e↔w u↔d）：侦测器输出在检测面的背面 */
const OPPOSITE_FACING = [2, 3, 0, 1, 5, 4] as const;

interface ObserverStart {
  key: string;
  at: number;
}

/** 待发出的侦测器脉冲（检测到变化后延迟 1 红刻发出，MC Java） */
const pendingObserverStarts: ObserverStart[] = [];

/** 调度侦测器脉冲：延迟 1 红石刻发出；已调度不重复；脉冲输出中再触发则刷新到期时刻（去抖） */
function scheduleObserverPulse(k: string): void {
  if (sources.has(k)) {
    const existing = pendingPulses.find((p) => p.key === k && p.kind === 'observer');
    if (existing) existing.at = simTime + 0.1;
    return;
  }
  if (pendingObserverStarts.some((p) => p.key === k)) return;
  pendingObserverStarts.push({ key: k, at: simTime + 0.1 });
}

/** tickObservers 帧内复用的待删键列表（遍历时只收集、遍历后删除，语义与原 [...observers] 快照等价） */
const observerRemoveScratch: string[] = [];

/** 每 tick：消费被活塞推动的侦测器（推后发一次脉冲，Java 飞行器原理）+ 比对各侦测器面朝格状态签名 */
function tickObservers(world: World): void {
  for (const k of pushedObservers) if (observers.has(k)) scheduleObserverPulse(k);
  pushedObservers.clear();
  observerRemoveScratch.length = 0;
  for (const [k, prev] of observers) {
    const [x, y, z] = k.split(',').map(Number);
    if (!world.isChunkLoaded(x, z)) continue; // 未加载：不读块（防隐式生成），登记与签名保留
    const id = world.getBlock(x, y, z);
    if (!isObserverId(id)) {
      observerRemoveScratch.push(k); // 兜底：被挖/推走（正常由 notifyRedstone 清理）
      continue;
    }
    const f = BLOCKS[id].facing ?? 0;
    const [dx, dy, dz] = FACING_VEC[f];
    const cur = obsSignature(world, x + dx, y + dy, z + dz);
    if (cur === prev) continue;
    observers.set(k, cur); // 更新已遍历到的既有键：安全，不会触发重复访问
    scheduleObserverPulse(k);
  }
  for (const k of observerRemoveScratch) observers.delete(k);
}

/** 音符盒：各位置的调音（半音 0-23）与充能态（上升沿发声） */
const notePitches = new Map<string, number>();
const noteStates = new Map<string, boolean>();

/** 世界 tick 调用：结算重播 / 压力板检测 / 侦测器比对与脉冲调度 / 脉冲发出与到期 / 比较器延迟结算 / 中继器延迟翻转（去抖——MC 特性） */
export function tickRedstone(world: World, dt: number): void {
  simTime += dt;
  if (pendingRecompute) {
    const [cx, cy, cz] = pendingRecompute;
    pendingRecompute = null;
    recompute(world, cx, cy, cz);
  }
  tickPlates(world);
  tickObservers(world);
  // 侦测器脉冲发出（检测/被推后延迟 1 红石刻，持续 1 红石刻，MC Java）
  if (pendingObserverStarts.length > 0) {
    const due = pendingObserverStarts.filter((p) => p.at <= simTime);
    for (let i = pendingObserverStarts.length - 1; i >= 0; i--) {
      if (pendingObserverStarts[i].at <= simTime) pendingObserverStarts.splice(i, 1);
    }
    for (const p of due) {
      const [x, y, z] = p.key.split(',').map(Number);
      if (!world.isChunkLoaded(x, z)) continue; // 脉冲发出时 chunk 已卸载：不隐式生成，脉冲丢弃
      const id = world.getBlock(x, y, z);
      if (!isObserverId(id)) continue;
      const f = BLOCKS[id].facing ?? 0;
      sources.add(p.key);
      dirSources.set(p.key, OPPOSITE_FACING[f] ?? 2);
      pendingPulses.push({ key: p.key, at: simTime + 0.1, kind: 'observer' });
      recompute(world, x, y, z);
    }
  }
  if (pendingPulses.length > 0) {
    const due = pendingPulses.filter((p) => p.at <= simTime);
    for (let i = pendingPulses.length - 1; i >= 0; i--) {
      if (pendingPulses[i].at <= simTime) pendingPulses.splice(i, 1);
    }
    for (const p of due) {
      const [x, y, z] = p.key.split(',').map(Number);
      if (!world.isChunkLoaded(x, z)) continue; // 到期时 chunk 已卸载：不隐式生成（按钮回弹由重载后 rescanSources 补排）
      if (p.kind === 'button') {
        // 按钮回弹（可能已被挖掉/读档后方块不在）
        const id = world.getBlock(x, y, z);
        if (isButtonOnId(id)) world.setBlock(x, y, z, BLOCK_BY_KEY[blockKeyOf(id).replace(/_on$/, '')].id);
      } else {
        // 侦测器/标靶脉冲到期：撤临时电源
        removeSource(x, y, z, p.key);
        recompute(world, x, y, z);
      }
    }
  }
  // 比较器延迟结算（1 红石刻）：到期按实时输入重算输出，变化才提交（去抖，等价 MC 的 1 tick 评估）
  if (pendingCompFlips.length > 0) {
    const due = pendingCompFlips.filter((f) => f.at <= simTime);
    for (let i = pendingCompFlips.length - 1; i >= 0; i--) {
      if (pendingCompFlips[i].at <= simTime) pendingCompFlips.splice(i, 1);
    }
    for (const f of due) {
      const [x, y, z] = f.key.split(',').map(Number);
      if (!world.isChunkLoaded(x, z)) continue; // 结算时 chunk 已卸载：不隐式生成
      const id = world.getBlock(x, y, z);
      if (!isComparatorId(id)) continue;
      const out = computeCompOut(world, x, y, z);
      const prev = compOutputs.get(f.key) ?? 0;
      if (out === prev) continue; // 去抖：输入已回一致
      compOutputs.set(f.key, out);
      const facing = BLOCKS[id].facing ?? 0;
      const [dx, dy, dz] = FACING_VEC[facing];
      const fk = key(x + dx, y + dy, z + dz);
      if (out > 0) compFront.set(fk, out);
      else {
        compFront.delete(fk);
        strong.delete(fk);
      }
      if ((out > 0) !== isComparatorOnId(id)) {
        // 开关态同步（setBlock 经 notifyRedstone 触发重算，前方粉/充能/元件随新输出刷新）
        const suf = ['n', 'e', 's', 'w'][facing];
        world.setBlock(x, y, z, BLOCK_BY_KEY[`comparator_${out > 0 ? 'on_' : ''}${suf}`].id);
      } else {
        recompute(world, x, y, z);
      }
    }
  }
  if (pendingFlips.length === 0) return;
  const due = pendingFlips.filter((f) => f.at <= simTime);
  for (let i = pendingFlips.length - 1; i >= 0; i--) {
    if (pendingFlips[i].at <= simTime) pendingFlips.splice(i, 1);
  }
  for (const f of due) {
    const [x, y, z] = f.key.split(',').map(Number);
    if (!world.isChunkLoaded(x, z)) continue; // 结算时 chunk 已卸载：不隐式生成
    const id = world.getBlock(x, y, z);
    if (!isRepeaterIdInternal(id)) continue;
    const facing = BLOCKS[id].facing ?? 0;
    const [dx, , dz] = FACING_VEC[facing];
    if (repeaterLocked(world, x, y, z, facing)) continue; // 侧向锁存：输出保持，丢弃待结算翻转（MC）
    const inputOn = inputAt(world, x, y, z, dx, dz);
    if (inputOn === isRepeaterOnId(id)) continue; // 去抖：输入已回一致
    const suf = ['n', 'e', 's', 'w'][facing];
    world.setBlock(x, y, z, BLOCK_BY_KEY[`repeater_${inputOn ? 'on_' : ''}${suf}`].id);
  }
}

// 世界作用域自注册（lib/worldScope.ts）：红石功率图/电源登记随世界清理
registerWorldScope({ name: 'redstone', clear: clearRedstone });

