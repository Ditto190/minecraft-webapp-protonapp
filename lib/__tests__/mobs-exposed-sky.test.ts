// 白天自燃 exposedToSky 的天空光快路径（lib/mobs.ts）：
// sky<15 ⇒ 同列上方必有不透明遮挡，O(1) 判不露天；sky===15 时仍扫列兜底树叶/水等非不透明遮挡
// （本引擎树叶 opaque:false，天空光穿透树冠，但 MC 树荫不烧由扫列保证）
import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, LEAVES, STONE } from '../blocks';
import { worldClock } from '../game';
import { flushLight } from '../lights';
import { clearMobs, spawnMobAt, tickMobs } from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { weather } from '../weather';
import { World } from '../world';

/** 石板地面（y=9）的虚空测试世界（chunk 生成自虚空，天空光初始全 15） */
function floorWorld(): World {
  const w = new World('exposed-sky', undefined, VOID_TERRAIN);
  for (let x = 4; x < 12; x++) for (let z = 4; z < 12; z++) w.setBlock(x, 9, z, STONE);
  return w;
}

/** 5×5 顶棚（僵尸在攻击距离内不游走，顶棚覆盖面足够） */
function roof(w: World, id: number): void {
  for (let x = 6; x <= 10; x++) for (let z = 6; z <= 10; z++) w.setBlock(x, 14, z, id);
}

const player = { x: 8.5, y: 10, z: 8.5 };

/** 小步长 tick（dt=1 大步长会隧穿地板；5×0.2s = 烧 1 点血） */
function tick(w: World, n = 5): void {
  for (let i = 0; i < n; i++) tickMobs(w, 0.2, player, () => undefined);
}

beforeEach(() => {
  clearMobs();
  worldClock.t = 0.25; // 正午
  weather.kind = 'clear';
});

describe('白天自燃：天空光快路径', () => {
  it('露天僵尸白天自燃（基线：sky===15 + 扫列全空）', () => {
    const w = floorWorld();
    const z = spawnMobAt('zombie', 8.5, 10, 8.5);
    tick(w);
    expect(z.hp).toBeLessThan(20);
  });

  it('不透明顶棚 flushLight 后不烧（sky<15 快路径直通）', () => {
    const w = floorWorld();
    roof(w, STONE);
    flushLight(w); // 应用增量光照：顶棚下 sky<15
    const z = spawnMobAt('zombie', 8.5, 10, 8.5);
    tick(w);
    expect(z.hp).toBe(20);
  });

  it('树叶顶棚 flushLight 后照烧（colTop 只认不透明方块；树叶/水/玻璃不遮挡）', () => {
    const w = floorWorld();
    roof(w, LEAVES);
    flushLight(w); // 树叶 opaque:false → 顶棚下 sky 仍 15，但 colTop 只统计不透明方块
    const z = spawnMobAt('zombie', 8.5, 10, 8.5);
    tick(w);
    expect(z.hp).toBeLessThan(20);
  });

  it('顶棚挖掉并 flushLight 后恢复露天照烧（陈旧 sky 随光照刷新恢复）', () => {
    const w = floorWorld();
    roof(w, STONE);
    flushLight(w);
    const z = spawnMobAt('zombie', 8.5, 10, 8.5);
    tick(w);
    expect(z.hp).toBe(20);
    roof(w, AIR);
    flushLight(w);
    tick(w);
    expect(z.hp).toBeLessThan(20);
  });
});
