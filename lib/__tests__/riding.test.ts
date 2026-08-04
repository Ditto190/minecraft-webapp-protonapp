// 骑乘系统（快乐恶魂坐骑）：上马条件（防御读取）/ 骑乘控制 / 吸附 / 下马
//（Player.tsx 帧循环调用 lib/physics.ts 的同款纯函数，此处单测规则本身；mob 用字面量 mock，走防御读取路径）

import { describe, expect, it } from 'vitest';
import { STONE } from '../blocks';
import { VOID_TERRAIN } from '../noise';
import {
  RIDE_HALF_W,
  RIDE_HEIGHT,
  RIDE_OFFSET_Y,
  RIDE_SPEED,
  RIDE_VERT_SPEED,
  canRide,
  dismountRide,
  isHappyGhast,
  mountRide,
  rideControl,
  rideSnap,
  type RideMountLike,
} from '../physics';
import { World } from '../world';

/** 16×16 石板地面（y=9，顶面 y=10）；坐骑初始悬浮在 y=12（空中，四周空旷） */
function floorWorld(): World {
  const w = new World('riding', undefined, VOID_TERRAIN);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) w.setBlock(x, 9, z, STONE);
  }
  return w;
}

/** mock 快乐恶魂（防御读取路径：缺省字段 = 接口未提供时的表现） */
function mockGhast(over: Partial<RideMountLike> = {}): RideMountLike {
  return { type: 'happy_ghast', x: 8.5, y: 12, z: 8.5, hp: 20, harnessed: true, ...over };
}

describe('上马条件（isHappyGhast / canRide / mountRide，防御读取）', () => {
  it('已装鞍的快乐恶魂：可骑，上马标记 riddenByPlayer', () => {
    const m = mockGhast();
    expect(isHappyGhast(m)).toBe(true);
    expect(canRide(m)).toBe(true);
    expect(mountRide(m)).toBe(true);
    expect(m.riddenByPlayer).toBe(true);
  });

  it('未装鞍（harnessed 缺失/false）：不可骑——防御读取缺失字段视为未装鞍', () => {
    const noField = mockGhast();
    delete noField.harnessed; // 接口未就绪/旧数据：字段缺失
    expect(isHappyGhast(noField)).toBe(true); // 是快乐恶魂（提示「需要鞍具」用）
    expect(canRide(noField)).toBe(false);
    expect(mountRide(noField)).toBe(false);
    expect(noField.riddenByPlayer).toBeUndefined();
    expect(canRide(mockGhast({ harnessed: false }))).toBe(false);
  });

  it('harnessed 为真值但非严格 true（如 1）：防御为不可骑（接口约定严格布尔）', () => {
    expect(canRide(mockGhast({ harnessed: 1 as unknown as boolean }))).toBe(false);
  });

  it('其他生物即使带 harnessed 字段也不可骑（类型门禁）', () => {
    expect(isHappyGhast(mockGhast({ type: 'pig' }))).toBe(false);
    expect(canRide(mockGhast({ type: 'pig' }))).toBe(false);
    // 普通恶魂不是快乐恶魂
    expect(isHappyGhast(mockGhast({ type: 'ghast' }))).toBe(false);
  });

  it('死亡/倒地中的坐骑不可骑（自动下马判定条件）', () => {
    expect(canRide(mockGhast({ hp: 0 }))).toBe(false);
    expect(canRide(mockGhast({ deathTimer: 0.5 }))).toBe(false);
    // 卸鞍（harnessed 变 false）同样触发自动下马
    expect(canRide(mockGhast({ harnessed: false }))).toBe(false);
  });

  it('null/undefined 防御：不崩、不可骑', () => {
    expect(isHappyGhast(null)).toBe(false);
    expect(isHappyGhast(undefined)).toBe(false);
    expect(canRide(null)).toBe(false);
    expect(canRide(undefined)).toBe(false);
    expect(mountRide(null)).toBe(false);
  });

  it('下马：解除 riddenByPlayer 标记；空引用安全', () => {
    const m = mockGhast();
    mountRide(m);
    expect(m.riddenByPlayer).toBe(true);
    dismountRide(m);
    expect(m.riddenByPlayer).toBe(false);
    expect(() => dismountRide(null)).not.toThrow();
    expect(() => dismountRide(undefined)).not.toThrow();
  });
});

describe('骑手吸附（rideSnap）', () => {
  it('玩家位置原地改写到坐骑头顶（y + 2.2）', () => {
    const m = mockGhast({ x: 8.5, y: 12, z: 8.5 });
    const p = { x: 0, y: 0, z: 0 };
    rideSnap(p, m);
    expect(RIDE_OFFSET_Y).toBe(2.2);
    expect(p).toEqual({ x: 8.5, y: 14.2, z: 8.5 });
  });

  it('坐骑移动后吸附跟随（逐帧调用语义）', () => {
    const m = mockGhast();
    const p = { x: 0, y: 0, z: 0 };
    m.x += 3;
    m.y += 1;
    rideSnap(p, m);
    expect(p).toEqual({ x: 11.5, y: 15.2, z: 8.5 });
  });
});

describe('骑乘控制（rideControl）', () => {
  it('WASD 沿相机水平朝向移动：朝 -Z 看按 W 向 -Z 飞（~9.8 格/s）', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 1, 0, 0, 0.1); // fx=0, fz=-1, f=1, r=0
    expect(RIDE_SPEED).toBe(9.8);
    expect(m.z).toBeCloseTo(8.5 - RIDE_SPEED * 0.1, 5);
    expect(m.x).toBe(8.5); // 无侧向输入不动
    expect(m.y).toBe(12); // 无垂直输入悬浮
  });

  it('右移 = 前进 × up：朝 -Z 看按 D 向 +X', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 0, 1, 0, 0.1);
    expect(m.x).toBeCloseTo(8.5 + RIDE_SPEED * 0.1, 5);
    expect(m.z).toBe(8.5);
  });

  it('键盘对角线归一化：斜向合成速度仍是 RIDE_SPEED', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 1, 1, 0, 0.1); // W+D
    const dx = m.x - 8.5;
    const dz = m.z - 8.5;
    expect(Math.hypot(dx, dz)).toBeCloseTo(RIDE_SPEED * 0.1, 5);
  });

  it('触屏模拟量保留力度：半推摇杆半速', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 0.5, 0, 0, 0.1);
    expect(m.z).toBeCloseTo(8.5 - RIDE_SPEED * 0.5 * 0.1, 5);
  });

  it('空格上升 / Shift 下降（up ±1，~7 格/s）', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 0, 0, 1, 0.1);
    expect(RIDE_VERT_SPEED).toBe(7);
    expect(m.y).toBeCloseTo(12 + RIDE_VERT_SPEED * 0.1, 5);
    rideControl(w, m, 0, -1, 0, 0, -1, 0.2);
    expect(m.y).toBeCloseTo(12 + RIDE_VERT_SPEED * 0.1 - RIDE_VERT_SPEED * 0.2, 5);
  });

  it('下降撞到地面：停在地板顶面（不穿透）', () => {
    const w = floorWorld();
    const m = mockGhast();
    rideControl(w, m, 0, -1, 0, 0, -1, 0.5); // 下压 3.5 格，撞上 y=9 地板
    expect(m.y).toBeCloseTo(10.001, 3); // 地板 y=9 顶面 10 + EPS
  });

  it('水平撞墙：截停该轴推回（4×4×4 碰撞箱，MC 快乐恶魂体型）', () => {
    const w = floorWorld();
    for (let y = 12; y < 16; y++) w.setBlock(8, y, 5, STONE); // z∈[5,6] 的墙，挡住坐骑高度
    const m = mockGhast();
    rideControl(w, m, 0, -1, 1, 0, 0, 0.5); // 向 -Z 大步长飞
    expect(m.z).toBeCloseTo(6 + RIDE_HALF_W + 0.001, 3); // 墙面 z=6 + 半宽 2 + EPS
    expect(m.x).toBe(8.5);
  });

  it('上升撞到天花板：停在天花板下（不穿透）', () => {
    const w = floorWorld();
    w.setBlock(8, 16, 8, STONE); // y∈[16,17] 天花板
    const m = mockGhast();
    rideControl(w, m, 0, -1, 0, 0, 1, 0.5); // 大步长上升
    expect(m.y).toBeCloseTo(16 - RIDE_HEIGHT - 0.001, 3); // 天花板底 16 - 箱高 4 - EPS
  });
});
