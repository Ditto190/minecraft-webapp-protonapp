// AABB 碰撞与占位检测：玩家（Player）与怪物（mobs）共用；碰撞盒按方块形状（台阶半高/栅栏 1.5/门薄面板/花草无）
// 另含 MC Java 移动手感纯函数：双击触发（冲刺/切飞行）、潜行边缘防跌落、藤蔓攀爬（Player.tsx 帧循环调用，可单测）

import { AIR, BLOCK_BY_KEY, BLOCKS, type BlockId } from './blocks';
import type { World } from './world';

export interface Aabb {
  x: number;
  y: number;
  z: number;
}

export type Box3 = readonly [number, number, number, number, number, number];

/** 满格方块的共享默认碰撞盒（免每次分配；各调用方只读） */
const FULL_BOX: Box3 = [0, 0, 0, 1, 1, 1];

/** 方块碰撞盒 [minX,minY,minZ,maxX,maxY,maxZ]（无碰撞返回 null：花草/水/空气） */
export function blockBox(id: BlockId): Box3 | null {
  const def = BLOCKS[id];
  if (!def?.solid) return null;
  return def.box3 ?? FULL_BOX;
}

const EPS = 0.001;

/** 玩家碰撞盒半宽（Player 移动/潜行防跌、放置拒绝与放置预览共用） */
export const PLAYER_HALF_W = 0.3;
/** 玩家碰撞盒高度（同上） */
export const PLAYER_HEIGHT = 1.8;

/** 方块格 [bx,by,bz] 是否与玩家 AABB 重叠（tryPlace 的放置拒绝与 PlacePreview 的预览隐藏共用同一判定） */
export function blockIntersectsPlayer(p: Aabb, bx: number, by: number, bz: number): boolean {
  return (
    bx + 1 > p.x - PLAYER_HALF_W &&
    bx < p.x + PLAYER_HALF_W &&
    bz + 1 > p.z - PLAYER_HALF_W &&
    bz < p.z + PLAYER_HALF_W &&
    by + 1 > p.y &&
    by < p.y + PLAYER_HEIGHT
  );
}

function overlaps(p: Aabb, halfW: number, height: number, x: number, y: number, z: number, b: Box3): boolean {
  return (
    p.x + halfW > x + b[0] + EPS &&
    p.x - halfW < x + b[3] - EPS &&
    p.y + height > y + b[1] + EPS &&
    p.y < y + b[4] - EPS &&
    p.z + halfW > z + b[2] + EPS &&
    p.z - halfW < z + b[5] - EPS
  );
}

/** 逐轴 AABB 碰撞：移动后若与实心方块碰撞盒重叠则推回，返回是否碰撞 */
export function collideAxis(
  world: World,
  p: Aabb,
  axis: 0 | 1 | 2,
  delta: number,
  halfW: number,
  height: number,
): boolean {
  if (delta === 0) return false;
  const minX = Math.floor(p.x - halfW);
  const maxX = Math.floor(p.x + halfW);
  const minY = Math.floor(p.y);
  const maxY = Math.floor(p.y + height - EPS);
  const minZ = Math.floor(p.z - halfW);
  const maxZ = Math.floor(p.z + halfW);
  let hit = false;
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const id = world.getBlock(x, y, z);
        if (id === AIR) continue; // 被扫格绝大多数是空气：跳过 blockBox 的表查找
        const box = blockBox(id);
        if (!box) continue;
        if (!overlaps(p, halfW, height, x, y, z, box)) continue;
        hit = true;
        if (axis === 0) {
          p.x = delta > 0 ? Math.min(p.x, x + box[0] - halfW - EPS) : Math.max(p.x, x + box[3] + halfW + EPS);
        } else if (axis === 1) {
          p.y = delta > 0 ? Math.min(p.y, y + box[1] - height - EPS) : Math.max(p.y, y + box[4] + EPS);
        } else {
          p.z = delta > 0 ? Math.min(p.z, z + box[2] - halfW - EPS) : Math.max(p.z, z + box[5] + halfW + EPS);
        }
      }
    }
  }
  return hit;
}

/** AABB 是否与任何实心方块碰撞盒重叠 */
export function aabbFree(world: World, x: number, y: number, z: number, halfW: number, height: number): boolean {
  const minX = Math.floor(x - halfW);
  const maxX = Math.floor(x + halfW);
  const minY = Math.floor(y);
  const maxY = Math.floor(y + height - EPS);
  const minZ = Math.floor(z - halfW);
  const maxZ = Math.floor(z + halfW);
  for (let yy = minY; yy <= maxY; yy++) {
    for (let zz = minZ; zz <= maxZ; zz++) {
      for (let xx = minX; xx <= maxX; xx++) {
        const id = world.getBlock(xx, yy, zz);
        if (id === AIR) continue;
        const box = blockBox(id);
        if (!box) continue;
        if (!overlaps({ x, y, z }, halfW, height, xx, yy, zz, box)) continue;
        return false;
      }
    }
  }
  return true;
}

// ——— MC Java 移动手感（Player.tsx 帧循环调用） ———

/** 双击检测器（MC Java ≤0.25s 窗口）：双击 W 冲刺、双击空格切飞行共用。
 *  每次按下（非长按 repeat）调 press；窗口内第二次按下返回 true，超时则重置为首击 */
export class DoubleTap {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly windowMs: number) {}
  /** 记录一次按下，返回是否构成双击（与上一击间隔 ≤ 窗口） */
  press(now: number): boolean {
    const hit = now - this.last <= this.windowMs;
    this.last = now;
    return hit;
  }
}

/** 双击 W 冲刺激活态（MC Java）：双击激活后，W 松开或不再前移（停下）即取消 */
export function wSprintNext(active: boolean, wHeld: boolean, forward: number): boolean {
  return active && wHeld && forward > 0;
}

/** 潜行防跌落支撑：脚下格（floor(y)-1）实心即可站（台阶半高等非满高实心同样算——Java 潜行可走上半阶台阶边缘，满格落差才拦） */
function sneakSupport(world: World, x: number, y: number, z: number): boolean {
  return BLOCKS[world.getBlock(Math.floor(x), Math.floor(y) - 1, Math.floor(z))]?.solid === true;
}

/** MC 潜行边缘防跌落：着地潜行（active = sneaking && onGround）时，目标轴向前缘脚下无支撑则截停该轴移动。
 *  只防水平走出边缘——跳跃/飞行/攀爬/水中时调用方传 active = false 原样放行（跳下去/被推下去不拦） */
export function sneakEdgeClip(
  world: World,
  p: Aabb,
  wantX: number,
  wantZ: number,
  mx: number,
  mz: number,
  active: boolean,
): { x: number; z: number } {
  if (!active) return { x: wantX, z: wantZ };
  let x = wantX;
  let z = wantZ;
  if (mx !== 0 && !sneakSupport(world, x + Math.sign(mx) * (PLAYER_HALF_W + 0.05), p.y, p.z)) x = p.x;
  if (mz !== 0 && !sneakSupport(world, x, p.y, z + Math.sign(mz) * (PLAYER_HALF_W + 0.05))) z = p.z;
  return { x, z };
}

/** 贴墙藤蔓 ID（blocks.ts 的 vine_n/e/s/w：薄板贴墙、无碰撞；MC CLIMBABLE） */
const VINE_IDS = new Set<number>([BLOCK_BY_KEY.vine_n.id, BLOCK_BY_KEY.vine_e.id, BLOCK_BY_KEY.vine_s.id, BLOCK_BY_KEY.vine_w.id]);

/** 是否可攀爬藤蔓方块 */
export function isVineId(id: BlockId): boolean {
  return VINE_IDS.has(id);
}

/** 玩家 AABB 是否与藤蔓相贴：同格或 0.1 格内的相邻格有藤蔓即算（MC Java：贴藤即可攀爬） */
export function touchingVine(world: World, p: Aabb, halfW: number, height: number): boolean {
  const REACH = 0.1;
  const minX = Math.floor(p.x - halfW - REACH);
  const maxX = Math.floor(p.x + halfW + REACH);
  const minY = Math.floor(p.y);
  const maxY = Math.floor(p.y + height - EPS);
  const minZ = Math.floor(p.z - halfW - REACH);
  const maxZ = Math.floor(p.z + halfW + REACH);
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (isVineId(world.getBlock(x, y, z))) return true;
      }
    }
  }
  return false;
}

/** 藤蔓攀爬上升速度（格/秒）：MC Java 攀爬 ~0.15 格/tick 量级 */
export const CLIMB_SPEED = 3;

/** 藤蔓攀爬垂直速度（MC Java）：按住前进缓慢上升，松开悬停（不下坠），按 Shift 停住不动 */
export function climbVelY(sneak: boolean, forward: number): number {
  if (sneak) return 0;
  return forward > 0 ? CLIMB_SPEED : 0;
}

// ——— 冲刺游泳（MC Java 1.13+ 俯泳，Player.tsx 帧循环调用） ———

/** 俯泳速度倍率：Java 冲刺游泳约为普通游泳 1.3-1.4 倍（取 1.35；海豚的恩惠另算，未做） */
export const SPRINT_SWIM_MULT = 1.35;
/** 俯泳碰撞箱高度（Java 0.6，可过 1 格缝）。项目碰撞按高度参数化（collideAxis），直接换低碰撞箱 */
export const SWIM_HEIGHT = 0.6;
/** 俯泳视点高度（Java 0.4） */
export const SWIM_EYE = 0.4;

/**
 * 俯泳姿态进出条件（MC Java）：水中按住冲刺且未站底 → 进入/保持；出水 / 松开冲刺 / 站到底面 → 退出。
 * 退出需头顶容得下站立碰撞箱（hasHeadroom）：1 格缝里松冲刺仍保持低姿态，否则弹回站姿卡进天花板（Java 同款）。
 * 注意：姿态保持 ≠ 加速——速度倍率由 stanceSpeedMult 按 sprinting 现况结算，无冲刺只是低姿态爬行。
 */
export function sprintSwimNext(active: boolean, inWater: boolean, sprinting: boolean, standing: boolean, hasHeadroom: boolean): boolean {
  if (inWater && sprinting && !standing) return true;
  return active && !hasHeadroom;
}

/** 姿态速度倍率（MC）：潜行 ~0.3、冲刺 ~1.3、俯泳 SPRINT_SWIM_MULT；仅俯泳姿态但无冲刺（缝隙里爬行）不加速 */
export function stanceSpeedMult(sneaking: boolean, sprinting: boolean, swimPose: boolean): number {
  if (sneaking) return 0.3;
  if (sprinting) return swimPose ? SPRINT_SWIM_MULT : 1.3;
  return 1;
}

// ——— 骑乘（快乐恶魂坐骑，Player.tsx 帧循环调用） ———
// 接口约定（快乐恶魂由 lib/mobs.ts 定义，此处只做防御性结构读取，不 import mobs 避免耦合）：
//   type === 'happy_ghast'、harnessed === true（已装鞍）→ 可骑；riddenByPlayer 由 Player 标记（mobs.ts AI/物理据此跳过）。
// 字段缺失/类型不符一律视为不可骑——对面接口未就绪时不崩不误判。

/** 骑乘目标的最小结构（mobs.ts 的 Mob 天然可赋值；测试可直接 mock 字面量） */
export interface RideMountLike {
  type: string;
  x: number;
  y: number;
  z: number;
  hp?: number;
  deathTimer?: number;
  /** 已装鞍（快乐恶魂 agent 提供；防御读取 (m as any).harnessed 的等价物——缺失即 false） */
  harnessed?: boolean;
  /** 被玩家骑乘中（Player 侧写入；约定 mobs.ts 的 AI/物理 tick 跳过该个体） */
  riddenByPlayer?: boolean;
}

/** 是否快乐恶魂（不管装鞍——右键提示「需要鞍具」与装鞍交互分流用） */
export function isHappyGhast(m: { type: string } | null | undefined): boolean {
  // m.type 在 MobType 并入 'happy_ghast' 前是联合类型外的字符串，故按 string 比较（防御）
  return !!m && (m.type as string) === 'happy_ghast';
}

/** 是否可骑：快乐恶魂 + 已装鞍 + 存活（死亡倒地动画中的尸体不可骑，与 mobInReach 跳过尸体一致） */
export function canRide(m: RideMountLike | null | undefined): boolean {
  return isHappyGhast(m) && m!.harnessed === true && (m!.hp ?? 1) > 0 && m!.deathTimer === undefined;
}

/** 上马：标记坐骑被骑（约定 mobs.ts 对 riddenByPlayer 个体跳过 AI 移动/重力/攻击），返回是否成功 */
export function mountRide(m: RideMountLike | null | undefined): boolean {
  if (!canRide(m)) return false;
  m!.riddenByPlayer = true;
  return true;
}

/** 下马/自动下马：解除被骑标记（骑乘状态不进存档——重载后玩家就地落回，坐骑留在原处） */
export function dismountRide(m: RideMountLike | null | undefined): void {
  if (m) m.riddenByPlayer = false;
}

/** 骑手吸附高度偏移：坐骑头顶骑乘位（快乐恶魂体型约 4 格高，头顶 ~2.2） */
export const RIDE_OFFSET_Y = 2.2;
/** 骑乘水平速度（格/秒）：MC 快乐恶魂飞行 ~9.8 格/s 量级 */
export const RIDE_SPEED = 9.8;
/** 骑乘垂直速度（格/秒）：空格上升 / Shift 下降（Java 是视线俯仰控制上下，从简用按键——项目触屏同理，更直观） */
export const RIDE_VERT_SPEED = 7;
/** 骑乘碰撞箱（MC 快乐恶魂约 4×4×4；若 mobs.ts 实际体型不同，改这两个常量对齐即可） */
export const RIDE_HALF_W = 2;
export const RIDE_HEIGHT = 4;

/** 骑乘碰撞收集盒 scratch（模块级复用、单线程顺序调用）：一次扫掠三轴并集，免逐轴重复 getBlock 同批方块与每帧分配 */
const sweptX: number[] = [];
const sweptY: number[] = [];
const sweptZ: number[] = [];
const sweptBox: Box3[] = [];

/**
 * 骑乘控制一帧：WASD 水平（沿相机水平朝向 fx/fz，模拟量保留力度）、up（空格+1 / Shift-1）垂直。
 * 碰撞：先把本帧三轴扫掠并集（各轴 [旧位置, 新位置] 的 AABB 包络）内的实心碰撞盒收集一次——
 * 空中常态（全集无实心块，快乐恶魂 4×4×4 箱逐轴要扫 ~125 格 ×3）直接应用位移跳过逐轴；
 * 有实心块时按 x→z→y 序、collideAxis 同款推回公式对列表解算（min/max 候选与格序无关，
 * 列表 ⊇ 各轴解析时的 AABB 覆盖格，非嵌入场景与逐轴扫描逐格等价）。
 * 差异边界：坐骑本帧起始已嵌进实心块（落沙/活塞推入）且被推回超出并集时，原逐轴实现后续轴
 * 会多扫到推回位置的新格——嵌入挤出属异常恢复路径，此处取并集内解算。
 */
export function rideControl(world: World, m: Aabb, fx: number, fz: number, f: number, r: number, up: number, dt: number): void {
  let mx = fx * f - fz * r;
  let mz = fz * f + fx * r;
  const len = Math.hypot(mx, mz);
  // 摇杆为模拟量：len ≤ 1 保留力度，超过 1（键盘对角线）才归一化（与 Player 行走同款处理）
  const scale = len > 1 ? RIDE_SPEED / len : RIDE_SPEED;
  mx *= scale;
  mz *= scale;
  const dx = mx * dt;
  const dz = mz * dt;
  const dy = up * RIDE_VERT_SPEED * dt;
  if (dx === 0 && dz === 0 && dy === 0) return; // 三轴 delta 均 0：与逐轴 collideAxis(0) 无操作等价

  const hw = RIDE_HALF_W;
  const h = RIDE_HEIGHT;
  const x0 = Math.floor(Math.min(m.x, m.x + dx) - hw);
  const x1 = Math.floor(Math.max(m.x, m.x + dx) + hw);
  const y0 = Math.floor(Math.min(m.y, m.y + dy));
  const y1 = Math.floor(Math.max(m.y, m.y + dy) + h - EPS);
  const z0 = Math.floor(Math.min(m.z, m.z + dz) - hw);
  const z1 = Math.floor(Math.max(m.z, m.z + dz) + hw);
  sweptX.length = 0;
  sweptY.length = 0;
  sweptZ.length = 0;
  sweptBox.length = 0;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const id = world.getBlock(x, y, z);
        if (id === AIR) continue;
        const box = blockBox(id);
        if (!box) continue;
        sweptX.push(x);
        sweptY.push(y);
        sweptZ.push(z);
        sweptBox.push(box);
      }
    }
  }
  if (sweptBox.length === 0) {
    m.x += dx;
    m.y += dy;
    m.z += dz;
    return;
  }
  // 逐轴解算（与 collideAxis 同推回公式；delta=0 的轴跳过——collideAxis(0) 本就不扫不推）
  if (dx !== 0) {
    m.x += dx;
    for (let i = 0; i < sweptBox.length; i++) {
      const box = sweptBox[i];
      if (!overlaps(m, hw, h, sweptX[i], sweptY[i], sweptZ[i], box)) continue;
      m.x = dx > 0 ? Math.min(m.x, sweptX[i] + box[0] - hw - EPS) : Math.max(m.x, sweptX[i] + box[3] + hw + EPS);
    }
  }
  if (dz !== 0) {
    m.z += dz;
    for (let i = 0; i < sweptBox.length; i++) {
      const box = sweptBox[i];
      if (!overlaps(m, hw, h, sweptX[i], sweptY[i], sweptZ[i], box)) continue;
      m.z = dz > 0 ? Math.min(m.z, sweptZ[i] + box[2] - hw - EPS) : Math.max(m.z, sweptZ[i] + box[5] + hw + EPS);
    }
  }
  if (dy !== 0) {
    m.y += dy;
    for (let i = 0; i < sweptBox.length; i++) {
      const box = sweptBox[i];
      if (!overlaps(m, hw, h, sweptX[i], sweptY[i], sweptZ[i], box)) continue;
      m.y = dy > 0 ? Math.min(m.y, sweptY[i] + box[1] - h - EPS) : Math.max(m.y, sweptY[i] + box[4] + EPS);
    }
  }
}

/** 骑手吸附：玩家位置原地改写到坐骑头顶（帧循环零分配；y + RIDE_OFFSET_Y） */
export function rideSnap(p: Aabb, m: Aabb): void {
  p.x = m.x;
  p.y = m.y + RIDE_OFFSET_Y;
  p.z = m.z;
}
