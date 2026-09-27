// 逐轴 AABB 碰撞回归：推回公式 / EPS 边距 / delta=0 无操作 / 形变盒（台阶）/ 嵌入挤出 /
// 骑乘大箱扫掠收集（rideControl 一次扫三轴并集，语义与逐轴 collideAxis 等价）
//（Player.tsx 帧循环与 mobs.ts 共用 lib/physics.ts 这套碰撞，此处锁定行为基线）

import { describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY, STONE } from '../blocks';
import { VOID_TERRAIN } from '../noise';
import { collideAxis, rideControl, RIDE_HALF_W, RIDE_SPEED, RIDE_VERT_SPEED } from '../physics';
import { World } from '../world';

/** 16×16 石板地面（y=9，顶面 y=10） */
function floorWorld(name: string): World {
  const w = new World(name, undefined, VOID_TERRAIN);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) w.setBlock(x, 9, z, STONE);
  }
  return w;
}

describe('逐轴碰撞（collideAxis）', () => {
  it('delta=0：无操作返回 false——即使嵌在实心块里也不推回（早退语义锁定）', () => {
    const w = floorWorld('collide-zero');
    w.setBlock(8, 10, 8, STONE);
    const p = { x: 8.5, y: 10.2, z: 8.5 }; // 嵌在石头里
    expect(collideAxis(w, p, 0, 0, 0.3, 1.8)).toBe(false);
    expect(collideAxis(w, p, 1, 0, 0.3, 1.8)).toBe(false);
    expect(collideAxis(w, p, 2, 0, 0.3, 1.8)).toBe(false);
    expect(p).toEqual({ x: 8.5, y: 10.2, z: 8.5 });
  });

  it('+x 撞墙：推到墙面 - 半宽 - EPS', () => {
    const w = floorWorld('collide-px');
    for (let y = 10; y < 13; y++) w.setBlock(10, y, 8, STONE); // 墙 x∈[10,11]
    const p = { x: 9.5, y: 10, z: 8.5 };
    p.x += 0.4; // 调用方先应用位移，collideAxis 只做推回（与 Player/mobs 调用序一致）
    expect(collideAxis(w, p, 0, 0.4, 0.3, 1.8)).toBe(true);
    expect(p.x).toBeCloseTo(10 - 0.3 - 0.001, 5);
    expect(p.y).toBe(10);
    expect(p.z).toBe(8.5);
  });

  it('-x / ±z 撞墙：镜像公式（墙面 + 半宽 + EPS）', () => {
    const w = floorWorld('collide-mirror');
    for (let y = 10; y < 13; y++) {
      w.setBlock(6, y, 4, STONE); // 墙 x∈[6,7]（p1 的 z 列）
      w.setBlock(4, y, 6, STONE); // 墙 z∈[6,7]（p2 的 x 列）
    }
    const p1 = { x: 6.5, y: 10, z: 4.5 };
    p1.x -= 0.4;
    expect(collideAxis(w, p1, 0, -0.4, 0.3, 1.8)).toBe(true);
    expect(p1.x).toBeCloseTo(7 + 0.3 + 0.001, 5);
    const p2 = { x: 4.5, y: 10, z: 6.5 };
    p2.z -= 0.4;
    expect(collideAxis(w, p2, 2, -0.4, 0.3, 1.8)).toBe(true);
    expect(p2.z).toBeCloseTo(7 + 0.3 + 0.001, 5);
  });

  it('-y 落地：停在方块顶面 + EPS；+y 升天：停在天花板底 - 高度 - EPS', () => {
    const w = floorWorld('collide-y');
    const p = { x: 8.5, y: 12, z: 8.5 };
    p.y -= 2.5;
    expect(collideAxis(w, p, 1, -2.5, 0.3, 1.8)).toBe(true);
    expect(p.y).toBeCloseTo(10 + 0.001, 5);
    w.setBlock(8, 14, 8, STONE); // 天花板 y∈[14,15]
    p.y += 3.5;
    expect(collideAxis(w, p, 1, 3.5, 0.3, 1.8)).toBe(true);
    expect(p.y).toBeCloseTo(14 - 1.8 - 0.001, 5);
  });

  it('下半砖只挡下半：同层 y 推回；站上其顶面高度后穿行不受挡', () => {
    const w = floorWorld('collide-slab');
    w.setBlock(10, 10, 8, BLOCK_BY_KEY.stone_slab.id); // 半高碰撞盒 [10,10.5]
    const p = { x: 9.5, y: 10, z: 8.5 }; // 脚与半砖同层 → y 区间与 [10,10.5] 重叠
    p.x += 0.4;
    expect(collideAxis(w, p, 0, 0.4, 0.3, 1.8)).toBe(true);
    expect(p.x).toBeCloseTo(10 - 0.3 - 0.001, 5);
    const p2 = { x: 9.5, y: 10.6, z: 8.5 }; // AABB 底 10.6 > 半砖顶 10.5 → 不重叠
    p2.x += 0.4;
    expect(collideAxis(w, p2, 0, 0.4, 0.3, 1.8)).toBe(false);
    expect(p2.x).toBeCloseTo(9.9, 5);
  });

  it('嵌入实心块后移动：按移动方向挤出到块面（恢复路径语义锁定）', () => {
    const w = floorWorld('collide-embed');
    w.setBlock(9, 10, 8, STONE); // 玩家嵌在该块里
    const p = { x: 9.5, y: 10, z: 8.5 };
    p.x += 0.05;
    expect(collideAxis(w, p, 0, 0.05, 0.3, 1.8)).toBe(true);
    expect(p.x).toBeCloseTo(9 - 0.3 - 0.001, 5); // +x 方向取 min 候选：挤到块左面
  });

  it('贴墙滑行不误撞：右缘停在 EPS 带内（距墙面 < EPS）的平行移动不受挡', () => {
    const w = floorWorld('collide-graze');
    for (let y = 10; y < 13; y++) w.setBlock(10, y, 8, STONE); // 墙 x∈[10,11]
    const p = { x: 10 - 0.3 - 0.01, y: 10, z: 8.5 }; // 右缘 9.99，距墙面 0.01 < EPS 带
    p.x += 0.005; // 移动后右缘 9.995 仍未越 10+EPS
    expect(collideAxis(w, p, 0, 0.005, 0.3, 1.8)).toBe(false);
    expect(p.x).toBeCloseTo(10 - 0.3 - 0.005, 5);
  });
});

describe('骑乘控制扫掠收集（rideControl：三轴并集一次扫，语义同逐轴 collideAxis）', () => {
  it('空中常态（并集无实心块）：三轴位移一次应用，与逐轴解算同结果', () => {
    const w = floorWorld('ride-sweep-empty');
    const m = { x: 8.5, y: 12, z: 8.5 };
    rideControl(w, m, 0, -1, 1, 0, 1, 0.1); // 前 + 上升，全程无碰撞体
    expect(m.x).toBe(8.5);
    expect(m.z).toBeCloseTo(8.5 - RIDE_SPEED * 0.1, 5);
    expect(m.y).toBeCloseTo(12 + RIDE_VERT_SPEED * 0.1, 5);
  });

  it('斜向撞角：先 x 截停再 z 截停（大箱 RIDE_HALF_W=2 全宽参与）', () => {
    const w = floorWorld('ride-sweep-corner');
    for (let y = 12; y < 16; y++) {
      w.setBlock(8, y, 5, STONE); // z∈[5,6] 墙
      w.setBlock(5, y, 8, STONE); // x∈[5,6] 墙
    }
    const m = { x: 8.5, y: 12, z: 8.5 };
    rideControl(w, m, 0, -1, 1, 0, 0, 0.5); // 向 -Z 飞
    expect(m.z).toBeCloseTo(6 + RIDE_HALF_W + 0.001, 3);
    expect(m.x).toBe(8.5); // 无 x 输入不动
  });

  it('下降撞地：停在地板顶面 + EPS（dt 与 Player 帧同量级，无穿隧）', () => {
    const w = floorWorld('ride-sweep-gap');
    const m = { x: 8.5, y: 12, z: 8.5 };
    rideControl(w, m, 0, -1, 0, 0, -1, 0.5); // 下压 3.5 格，撞上 y=9 地板
    expect(m.y).toBeCloseTo(10.001, 3); // 地板 y=9 顶面 10 + EPS
    expect(m.x).toBe(8.5);
    expect(m.z).toBe(8.5);
  });

  it('全零输入：原地不动（早退等价）', () => {
    const w = floorWorld('ride-sweep-idle');
    const m = { x: 8.5, y: 12, z: 8.5 };
    rideControl(w, m, 0, -1, 0, 0, 0, 0.016);
    expect(m).toEqual({ x: 8.5, y: 12, z: 8.5 });
  });
});
