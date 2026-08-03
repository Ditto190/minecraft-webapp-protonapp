// AABB 碰撞与占位检测：玩家（Player）与怪物（mobs）共用；碰撞盒按方块形状（台阶半高/栅栏 1.5/门薄面板/花草无）
// 另含 MC Java 移动手感纯函数：双击触发（冲刺/切飞行）、潜行边缘防跌落、藤蔓攀爬（Player.tsx 帧循环调用，可单测）

import { BLOCK_BY_KEY, BLOCKS, type BlockId } from './blocks';
import type { World } from './world';

export interface Aabb {
  x: number;
  y: number;
  z: number;
}

export type Box3 = readonly [number, number, number, number, number, number];

/** 方块碰撞盒 [minX,minY,minZ,maxX,maxY,maxZ]（无碰撞返回 null：花草/水/空气） */
export function blockBox(id: BlockId): Box3 | null {
  const def = BLOCKS[id];
  if (!def?.solid) return null;
  return def.box3 ?? [0, 0, 0, 1, 1, 1];
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
        const box = blockBox(world.getBlock(x, y, z));
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
        const box = blockBox(world.getBlock(xx, yy, zz));
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
