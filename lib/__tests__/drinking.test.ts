// 药水饮用读条（MC Java：手持药水按住右键 1.6s 喝完；松手/换槽/换物取消，读满才生效——
// 效果施加/生命回复/消耗瓶子；与进食共用读条骨架，eatState.kind === 'drink' 分支）

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3, type Camera } from 'three';
import { cancelEating, DRINK_DURATION, eatState, tickEating, tryPlace, useButton } from '../actions';
import { effects, effectLvls } from '../effects';
import { cameraRef, eatFeedback, playerPosition, setActiveWorld } from '../game';
import { VOID_TERRAIN } from '../noise';
import { emptySlots } from '../slots';
import { useGameStore } from '../store';
import { World } from '../world';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockCamera(): Camera {
  return {
    position: new Vector3(4.5, 31, 7.5),
    getWorldDirection: (v: Vector3) => v.set(0, 0, -1),
  } as unknown as Camera;
}

function setupPotion(material: string, count = 2, health = 20): World {
  const w = new World('drink-test', undefined, VOID_TERRAIN);
  setActiveWorld(w);
  cameraRef.current = mockCamera();
  playerPosition.x = 4.5;
  playerPosition.y = 31;
  playerPosition.z = 7.5;
  const hotbarSlots = emptySlots();
  hotbarSlots[0] = { kind: 'material', material, count };
  useGameStore.setState({ worldMode: 'survival', hotbarSlots, selectedSlot: 0, health, notice: null });
  cancelEating();
  useButton.held = false;
  return w;
}

/** 模拟松开使用键：桌面 useButton=false 且触屏连发续期超时 */
function releaseUse(): void {
  useButton.held = false;
  eatState.nudgedAt = performance.now() - 1000;
}

afterEach(() => {
  setActiveWorld(null);
  cameraRef.current = null;
  cancelEating();
  useButton.held = false;
  effects.speed = 0;
  effects.hunger = 0;
  effectLvls.speed = 1;
  eatFeedback.lastAteAt = 0;
  vi.restoreAllMocks();
});

describe('饮用读条', () => {
  it('右键手持药水：启动读条（kind=drink），不立即生效/不消耗', async () => {
    setupPotion('speed');
    await wait(160); // 放置冷却
    tryPlace();
    expect(eatState.active).toBe(true);
    expect(eatState.kind).toBe('drink');
    expect(eatState.progress).toBe(0);
    expect(eatState.material).toBe('speed');
    const s = useGameStore.getState();
    expect(effects.speed).toBe(0); // 尚未喝到
    expect(s.hotbarSlots[0]).toEqual({ kind: 'material', material: 'speed', count: 2 });
  });

  it('读满 1.6s 才生效：施加效果并消耗药水', async () => {
    setupPotion('speed', 1);
    await wait(160);
    tryPlace();
    useButton.held = true; // 桌面按住
    tickEating(DRINK_DURATION / 2);
    expect(effects.speed).toBe(0); // 半途还没喝到
    expect(useGameStore.getState().hotbarSlots[0]).toEqual({ kind: 'material', material: 'speed', count: 1 });
    tickEating(DRINK_DURATION / 2);
    expect(effects.speed).toBe(180); // 迅捷药水 I 级 3:00（MC）
    expect(effectLvls.speed).toBe(1);
    expect(useGameStore.getState().hotbarSlots[0]).toBeNull(); // 喝完消耗
    expect(eatState.active).toBe(false); // 同槽没药了自动停
  });

  it('中途松手：读条取消，无效果不消耗', async () => {
    setupPotion('speed');
    await wait(160);
    tryPlace();
    tickEating(0.5);
    releaseUse();
    tickEating(0.1);
    expect(eatState.active).toBe(false);
    expect(effects.speed).toBe(0);
    expect(useGameStore.getState().hotbarSlots[0]).toEqual({ kind: 'material', material: 'speed', count: 2 });
  });

  it('中途换槽：读条取消', async () => {
    setupPotion('speed');
    await wait(160);
    tryPlace();
    useGameStore.setState({ selectedSlot: 1 });
    tickEating(0.1);
    expect(eatState.active).toBe(false);
    expect(effects.speed).toBe(0);
  });

  it('触屏按住「放」的连发调用：续期不重启读条', async () => {
    setupPotion('speed', 1);
    await wait(160);
    tryPlace();
    tickEating(0.5);
    const before = eatState.progress;
    eatState.nudgedAt = performance.now() - 200; // 快超时了
    await wait(160); // 过放置冷却，连发的下一次 tryPlace 才能走到饮用分支
    tryPlace(); // 连发 nudge
    expect(eatState.active).toBe(true);
    expect(eatState.progress).toBe(before); // 没有重启
    expect(performance.now() - eatState.nudgedAt).toBeLessThan(200); // 续期成功
    tickEating(DRINK_DURATION); // 继续推进可完成
    expect(effects.speed).toBe(180);
  });

  it('水瓶/粗制药水无效果：不启动读条，提示「没什么味道…」（MC Java 不可饮用）', async () => {
    setupPotion('water_bottle');
    await wait(160);
    tryPlace();
    expect(eatState.active).toBe(false);
    expect(useGameStore.getState().notice).toBe('没什么味道…');
    expect(useGameStore.getState().hotbarSlots[0]).toEqual({ kind: 'material', material: 'water_bottle', count: 2 });
  });

  it('治疗药水 II：读满瞬回 4 心（MC）', async () => {
    setupPotion('healing_2', 1, 10);
    await wait(160);
    tryPlace();
    useButton.held = true;
    tickEating(DRINK_DURATION);
    expect(useGameStore.getState().health).toBe(18); // 10 + 8
    expect(useGameStore.getState().hotbarSlots[0]).toBeNull();
  });

  it('喝完写 eatFeedback.lastAteAt（Java 喝完也打嗝，Hud 打嗝钩子）', async () => {
    setupPotion('speed', 1);
    await wait(160);
    tryPlace();
    useButton.held = true;
    tickEating(DRINK_DURATION);
    expect(effects.speed).toBe(180); // 确认真正喝到了
    expect(eatFeedback.lastAteAt).toBeGreaterThan(0);
  });

  it('饮用结算不进食物专属路径（紫颂果传送/腐肉饥饿 roll 误伤检查）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01); // 即使必中也只限腐肉/生鸡肉
    setupPotion('speed', 1);
    await wait(160);
    tryPlace();
    useButton.held = true;
    tickEating(DRINK_DURATION);
    expect(effects.speed).toBe(180);
    expect(effects.hunger).toBe(0); // 食物专属 roll 未进药水路径
    expect(playerPosition.x).toBe(4.5); // 无紫颂果式传送
  });

  it('仍按住且同槽还有药水：自动续饮下一瓶（MC）', async () => {
    setupPotion('speed', 2);
    await wait(160);
    tryPlace();
    useButton.held = true;
    tickEating(DRINK_DURATION);
    expect(effects.speed).toBe(180); // 第一瓶生效
    expect(eatState.active).toBe(true); // 自动续饮第二瓶
    expect(eatState.progress).toBe(0);
    expect(useGameStore.getState().hotbarSlots[0]).toEqual({ kind: 'material', material: 'speed', count: 1 });
    tickEating(DRINK_DURATION);
    expect(useGameStore.getState().hotbarSlots[0]).toBeNull(); // 第二瓶喝完
    expect(eatState.active).toBe(false);
  });
});
