// 手感反馈共享状态（lib/game.ts）：相机震动 addShake（累加/封顶/包络折损）、爆炸按距离触发震动、
// 进食结算写 eatFeedback.lastAteAt（Hud 打嗝钩子）、burningState 导出存在（Player 每帧写入，无纯逻辑可测）

import { afterEach, describe, expect, it } from 'vitest';
import { Vector3, type Camera } from 'three';
import { tickEating, tryPlace, useButton, cancelEating, EAT_DURATION } from '../actions';
import { explodeAt } from '../explosion';
import { addShake, burningState, cameraShake, cameraRef, eatFeedback, playerPosition, setActiveWorld, SHAKE_DECAY_MS } from '../game';
import { VOID_TERRAIN } from '../noise';
import { emptySlots } from '../slots';
import { useGameStore } from '../store';
import { World } from '../world';

const TNT_OPTS = { radius: 4, maxDamage: 32, hurtRadius: 7, tnt: true };

function resetShake(): void {
  cameraShake.mag = 0;
  cameraShake.at = 0;
}

afterEach(() => {
  resetShake();
  setActiveWorld(null);
  cameraRef.current = null;
  cancelEating();
  useButton.held = false;
});

describe('addShake 相机震动', () => {
  it('累加并封顶 1（连续爆炸不越叠越猛）', () => {
    addShake(0.5);
    expect(cameraShake.mag).toBeCloseTo(0.5);
    addShake(0.4);
    expect(cameraShake.mag).toBeCloseTo(0.9);
    addShake(0.4);
    expect(cameraShake.mag).toBe(1);
  });

  it('旧震动按包络折损后再累加（at 起 SHAKE_DECAY_MS 线性衰减）', () => {
    cameraShake.mag = 0.4;
    cameraShake.at = performance.now() - SHAKE_DECAY_MS / 2; // 衰减到一半 ≈ 0.2
    addShake(0.3);
    expect(cameraShake.mag).toBeCloseTo(0.5, 1);
  });

  it('旧震动完全衰减后不累加（只留新震动）', () => {
    cameraShake.mag = 1;
    cameraShake.at = performance.now() - SHAKE_DECAY_MS - 10;
    addShake(0.2);
    expect(cameraShake.mag).toBeCloseTo(0.2);
  });
});

describe('爆炸屏幕震动', () => {
  it('近距离爆炸触发震动（按距离衰减，伤害半径外 6 格内仍有感）', () => {
    const w = new World('shake-near', undefined, VOID_TERRAIN);
    explodeAt(w, 4.5, 10.5, 4.5, { x: 8.5, y: 10, z: 4.5 }, () => {}, TNT_OPTS);
    expect(cameraShake.mag).toBeGreaterThan(0);
    expect(cameraShake.mag).toBeLessThanOrEqual(1);
  });

  it('远处爆炸不触发震动', () => {
    const w = new World('shake-far', undefined, VOID_TERRAIN);
    explodeAt(w, 4.5, 10.5, 4.5, { x: 100, y: 100, z: 100 }, () => {}, TNT_OPTS);
    expect(cameraShake.mag).toBe(0);
  });

  it('近距离震动强于中距离（距离衰减趋势）', () => {
    const w = new World('shake-dist', undefined, VOID_TERRAIN);
    explodeAt(w, 4.5, 10.5, 4.5, { x: 6.5, y: 10, z: 4.5 }, () => {}, TNT_OPTS); // ~2 格
    const near = cameraShake.mag;
    resetShake();
    explodeAt(w, 4.5, 10.5, 4.5, { x: 12.5, y: 10, z: 4.5 }, () => {}, TNT_OPTS); // ~8 格
    const mid = cameraShake.mag;
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
  });
});

describe('进食打嗝钩子', () => {
  it('读满结算时写 eatFeedback.lastAteAt', async () => {
    const w = new World('eat-feedback', undefined, VOID_TERRAIN);
    setActiveWorld(w);
    cameraRef.current = {
      position: new Vector3(4.5, 31, 7.5),
      getWorldDirection: (v: Vector3) => v.set(0, 0, -1),
    } as unknown as Camera;
    playerPosition.x = 4.5;
    playerPosition.y = 31;
    playerPosition.z = 7.5;
    const hotbarSlots = emptySlots();
    hotbarSlots[0] = { kind: 'material', material: 'bread', count: 3 };
    useGameStore.setState({ worldMode: 'survival', hotbarSlots, selectedSlot: 0, hunger: 10, saturation: 5, notice: null });
    cancelEating();
    eatFeedback.lastAteAt = 0;
    await new Promise((r) => setTimeout(r, 160)); // 放置冷却
    tryPlace();
    useButton.held = true;
    tickEating(EAT_DURATION);
    expect(useGameStore.getState().hunger).toBeGreaterThan(10); // 确认真正吃到了
    expect(eatFeedback.lastAteAt).toBeGreaterThan(0);
  });
});

describe('着火状态桥', () => {
  it('burningState 导出且默认未燃烧（Player 每帧写入 burningLeft）', () => {
    expect(burningState.burningLeft).toBe(0);
  });
});
