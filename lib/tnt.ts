// 点燃的 TNT 实体：重力下落 + 爆炸击退（水平速度积分）+ 闪烁引信（MC 4 秒）+ 到期爆炸

import { BLOCKS } from './blocks';
import { explodeAt } from './explosion';
import type { World } from './world';
import { registerWorldScope } from './worldScope';

export interface PrimedTnt {
  id: number;
  x: number;
  y: number;
  z: number;
  /** 水平速度（爆炸击退冲量，格/秒）；旧快照缺省视为 0 */
  vx?: number;
  vz?: number;
  vy: number;
  /** 剩余引信秒数（MC 80 tick = 4s） */
  fuse: number;
}

export const primedTnt: PrimedTnt[] = [];
let nextId = 1;

const FUSE_SECONDS = 4;

/** 点燃 TNT：默认 4s 引信（打火石/红石路径，MC 80 tick）；爆炸连锁传随机短引信（MC 10-29 tick） */
export function igniteTnt(x: number, y: number, z: number, fuse = FUSE_SECONDS): void {
  primedTnt.push({ id: nextId++, x: x + 0.5, y: y + 0.02, z: z + 0.5, vy: 0.2, fuse });
}

export function clearTnt(): void {
  primedTnt.length = 0;
}

/** 每帧推进：重力 + 击退积分（撞实心方块停住，不穿透）+ 引信 */
export function tickTnt(
  world: World,
  dt: number,
  playerPos: { x: number; y: number; z: number },
  onAttackPlayer: (damage: number) => void,
): void {
  for (let i = primedTnt.length - 1; i >= 0; i--) {
    const t = primedTnt[i];
    t.fuse -= dt;
    // 水平击退（爆炸冲量）：阻尼衰减 + 逐轴积分，撞实心方块即停（最小速度支持，非完整物理）
    const drag = Math.max(0, 1 - 2 * dt); // 约 0.35s 减半，避免无限滑行
    t.vx = (t.vx ?? 0) * drag;
    t.vz = (t.vz ?? 0) * drag;
    if (t.vx !== 0) {
      const nx = t.x + t.vx * dt;
      if (BLOCKS[world.getBlock(Math.floor(nx + Math.sign(t.vx) * 0.49), Math.floor(t.y), Math.floor(t.z))]?.solid) t.vx = 0;
      else t.x = nx;
    }
    if (t.vz !== 0) {
      const nz = t.z + t.vz * dt;
      if (BLOCKS[world.getBlock(Math.floor(t.x), Math.floor(t.y), Math.floor(nz + Math.sign(t.vz) * 0.49))]?.solid) t.vz = 0;
      else t.z = nz;
    }
    t.vy = Math.max(t.vy - 12 * dt, -40); // 实体重力（比玩家轻，缓落）
    const nextY = t.y + t.vy * dt;
    if (t.vy < 0) {
      // 下落：找本格与途经格的实心阻挡，停在顶面上（实体高 0.98）
      const floorY = Math.floor(nextY - 0.02);
      if (BLOCKS[world.getBlock(Math.floor(t.x), floorY, Math.floor(t.z))]?.solid) {
        t.y = floorY + 1.02;
        t.vy = 0;
      } else {
        t.y = Math.max(0, nextY);
      }
    } else {
      t.y = nextY;
    }
    if (t.fuse <= 0) {
      primedTnt.splice(i, 1);
      explodeAt(world, t.x, t.y, t.z, playerPos, onAttackPlayer, {
        radius: 4,
        maxDamage: 32, // TNT 贴脸约 16 心（普通难度），取一半刻度对齐苦力怕 22
        hurtRadius: 7,
        tnt: true, // TNT 爆炸 100% 掉落（MC 1.14+）
      });
    }
  }
}

// 世界作用域自注册（lib/worldScope.ts）：点燃的 TNT 随维度暂存/恢复（否则跨维度泄漏/误删）
registerWorldScope<PrimedTnt[]>({
  name: 'tnt',
  clear: clearTnt,
  snapshot: () => [...primedTnt],
  restore: (entries) => {
    primedTnt.length = 0;
    primedTnt.push(...entries);
  },
});
