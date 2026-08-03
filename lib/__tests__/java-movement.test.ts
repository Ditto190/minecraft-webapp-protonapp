// MC Java 移动手感：双击 W 冲刺 / 双击空格切飞行 / 潜行边缘防跌落 / 藤蔓攀爬
//（Player.tsx 帧循环调用 lib/physics.ts 的同款纯函数，此处单测规则本身）

import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY, STONE } from '../blocks';
import { VOID_TERRAIN } from '../noise';
import {
  CLIMB_SPEED,
  DoubleTap,
  PLAYER_HALF_W,
  PLAYER_HEIGHT,
  climbVelY,
  isVineId,
  sneakEdgeClip,
  touchingVine,
  wSprintNext,
} from '../physics';
import { useGameStore } from '../store';
import { World } from '../world';

/** 16×16 石板地面（y=9，顶面 y=10），玩家站 y=10 */
function floorWorld(): World {
  const w = new World('java-movement', undefined, VOID_TERRAIN);
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) w.setBlock(x, 9, z, STONE);
  }
  return w;
}

afterEach(() => {
  useGameStore.setState({ worldMode: 'survival', flying: false });
});

describe('双击检测（DoubleTap，MC Java ≤0.25s 窗口）', () => {
  it('窗口内第二次按下激活（双击 W 冲刺触发）', () => {
    const tap = new DoubleTap(250);
    expect(tap.press(1000)).toBe(false); // 首击
    expect(tap.press(1200)).toBe(true); // 间隔 200ms ≤ 250ms
  });

  it('超出窗口不激活（慢点两次算两次单击）', () => {
    const tap = new DoubleTap(250);
    expect(tap.press(1000)).toBe(false);
    expect(tap.press(1300)).toBe(false); // 间隔 300ms > 250ms
  });

  it('窗口边界值 250ms 仍算双击', () => {
    const tap = new DoubleTap(250);
    tap.press(1000);
    expect(tap.press(1250)).toBe(true);
  });

  it('双击 W 冲刺：W 松开或停下（不再前移）即取消', () => {
    // 激活态保持：按住 W 且前移输入 > 0
    expect(wSprintNext(true, true, 1)).toBe(true);
    // 松开 W 取消
    expect(wSprintNext(true, false, 0)).toBe(false);
    // W 仍按但停下（W+S 抵消/顶住墙导致前移输入 ≤0）取消
    expect(wSprintNext(true, true, 0)).toBe(false);
    // 未激活不因按住 W 自激活（必须经 DoubleTap 双击触发）
    expect(wSprintNext(false, true, 1)).toBe(false);
  });
});

describe('双击空格切飞行（MC Java 创造）', () => {
  it('创造模式：双击空格 toggleFly 开/关飞行', () => {
    useGameStore.setState({ worldMode: 'creative', flying: false });
    useGameStore.getState().toggleFly();
    expect(useGameStore.getState().flying).toBe(true);
    useGameStore.getState().toggleFly();
    expect(useGameStore.getState().flying).toBe(false);
  });

  it('生存模式：双击空格不切飞行（toggleFly 内部门禁）', () => {
    useGameStore.setState({ worldMode: 'survival', flying: false });
    useGameStore.getState().toggleFly();
    expect(useGameStore.getState().flying).toBe(false);
  });
});

describe('潜行边缘防跌落（sneakEdgeClip，MC Java）', () => {
  it('着地潜行走向边缘：前沿脚下悬空，截停该轴', () => {
    const w = floorWorld();
    const p = { x: 15.2, y: 10, z: 8.5 };
    // +x 走出 0.3 格：前缘 15.85+0.35=16.2 → 格 16 无地板
    const out = sneakEdgeClip(w, p, 15.85, 8.5, 1, 0, true);
    expect(out.x).toBe(p.x); // 截停
    expect(out.z).toBe(8.5);
  });

  it('着地潜行在地面内部：正常移动不截停', () => {
    const w = floorWorld();
    const p = { x: 8.5, y: 10, z: 8.5 };
    const out = sneakEdgeClip(w, p, 9.0, 8.9, 1, 1, true);
    expect(out).toEqual({ x: 9.0, z: 8.9 });
  });

  it('跳跃中（active=false，onGround 为 false 时调用方不传 active）：走出边缘照样下落', () => {
    const w = floorWorld();
    const p = { x: 15.2, y: 10, z: 8.5 };
    const out = sneakEdgeClip(w, p, 15.85, 8.5, 1, 0, false);
    expect(out.x).toBe(15.85); // 放行 → 走出边缘掉下去
  });

  it('飞行中（active=false，飞行时 sneaking 恒 false）：不受影响', () => {
    const w = floorWorld();
    const p = { x: 15.2, y: 10, z: 8.5 };
    const out = sneakEdgeClip(w, p, 16.5, 9.5, 1, 1, false);
    expect(out).toEqual({ x: 16.5, z: 9.5 });
  });

  it('对角移动两轴都悬空：两轴分别截停', () => {
    const w = floorWorld();
    const p = { x: 15.2, y: 10, z: 15.2 };
    const out = sneakEdgeClip(w, p, 15.85, 15.85, 1, 1, true);
    expect(out).toEqual({ x: p.x, z: p.z });
  });

  it('前缘是下半格台阶（实心半高）：允许走下（Java 潜行可下台阶边缘）', () => {
    const w = floorWorld();
    w.setBlock(16, 9, 8, BLOCK_BY_KEY.stone_slab.id);
    const p = { x: 15.2, y: 10, z: 8.5 };
    const out = sneakEdgeClip(w, p, 15.85, 8.5, 1, 0, true);
    expect(out.x).toBe(15.85); // 不截停 → 落半格站上台阶
  });

  it('前缘悬空一格（下方才有地板）：满格落差仍截停（Java 潜行停在悬空边缘）', () => {
    const w = floorWorld();
    w.setBlock(16, 8, 8, STONE); // 低一整格
    const p = { x: 15.2, y: 10, z: 8.5 };
    const out = sneakEdgeClip(w, p, 15.85, 8.5, 1, 0, true);
    expect(out.x).toBe(p.x);
  });
});

describe('藤蔓攀爬（touchingVine / climbVelY，MC Java）', () => {
  it('isVineId：vine_n/e/s/w 是藤蔓，石头/空气不是', () => {
    expect(isVineId(BLOCK_BY_KEY.vine_n.id)).toBe(true);
    expect(isVineId(BLOCK_BY_KEY.vine_e.id)).toBe(true);
    expect(isVineId(BLOCK_BY_KEY.vine_s.id)).toBe(true);
    expect(isVineId(BLOCK_BY_KEY.vine_w.id)).toBe(true);
    expect(isVineId(STONE)).toBe(false);
    expect(isVineId(0)).toBe(false);
  });

  it('玩家与藤蔓同格：进入攀爬态', () => {
    const w = floorWorld();
    w.setBlock(4, 10, 4, BLOCK_BY_KEY.vine_n.id);
    expect(touchingVine(w, { x: 4.5, y: 10, z: 4.5 }, PLAYER_HALF_W, PLAYER_HEIGHT)).toBe(true);
  });

  it('藤蔓在贴面相邻格（0.1 容差内）：进入攀爬态', () => {
    const w = floorWorld();
    w.setBlock(5, 10, 4, BLOCK_BY_KEY.vine_s.id);
    // 玩家 AABB 右缘 5.29+0.3=5.59，扩展 0.1 探到格 5
    expect(touchingVine(w, { x: 5.29, y: 10, z: 4.5 }, PLAYER_HALF_W, PLAYER_HEIGHT)).toBe(true);
  });

  it('藤蔓够不着（相邻格之外）/高度不符：不攀爬', () => {
    const w = floorWorld();
    w.setBlock(6, 10, 4, BLOCK_BY_KEY.vine_n.id);
    expect(touchingVine(w, { x: 4.5, y: 10, z: 4.5 }, PLAYER_HALF_W, PLAYER_HEIGHT)).toBe(false);
    w.setBlock(4, 13, 4, BLOCK_BY_KEY.vine_n.id); // 头顶之上
    expect(touchingVine(w, { x: 4.5, y: 10, z: 4.5 }, PLAYER_HALF_W, PLAYER_HEIGHT)).toBe(false);
  });

  it('攀爬速度：按住前进上升（~0.15 格/tick = 3 格/s），松开悬停，Shift 停住', () => {
    expect(climbVelY(false, 1)).toBe(CLIMB_SPEED);
    expect(CLIMB_SPEED).toBe(3); // MC Java 0.15 格/tick × 20 tick/s
    expect(climbVelY(false, 0)).toBe(0); // 松开悬停不下坠
    expect(climbVelY(true, 1)).toBe(0); // Shift 停住不动
    expect(climbVelY(true, 0)).toBe(0);
  });
});
