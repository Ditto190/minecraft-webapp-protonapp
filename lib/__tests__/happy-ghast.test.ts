// 快乐恶魂全链（1.21.6 Chase the Skies）：
// 干恶魂方块（注册/配方/以物易物）→ 泡水复水孵小恶魂（雪球加速）→ 小恶魂长大 → 鞍具装备/卸下 → 被动/回血

import { beforeEach, describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, BLOCKS, ICON_TILE_COUNT, ICON_TILE_START } from '../blocks';
import { worldClock } from '../game';
import {
  accelerateDriedGhast,
  clearGrowthAges,
  DRIED_GHAST_REHYDRATE_SECONDS,
  rehydrationLeft,
  SNOWBALL_REHYDRATE_BOOST,
  tickGrowth,
  trackDriedGhast,
} from '../growth';
import { clearDrops, itemDrops } from '../items';
import { MATERIAL_INFO } from '../materials';
import {
  BARTER_TABLE,
  BREED_FOOD,
  clearMobs,
  damageMob,
  equipHarness,
  feedSnowball,
  GHASTLING_GROW_SECONDS,
  MOB_DEFS,
  mobs,
  SNOWBALL_GROWTH_BOOST,
  spawnGhastling,
  TEMPT_FOOD,
  tickMobs,
  unequipHarness,
  type Mob,
} from '../mobs';
import { VOID_TERRAIN } from '../noise';
import { applyCraft, canCraft, RECIPES, recipePattern } from '../recipes';
import type { Slot } from '../slots';
import { weather } from '../weather';
import { World } from '../world';

function voidWorld(): World {
  const w = new World('happy-ghast-test', undefined, VOID_TERRAIN);
  for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
  return w;
}

function mkHappy(x: number, y: number, z: number): Mob {
  return {
    id: Math.random(), type: 'happy_ghast', x, y, z,
    velY: 0, hp: MOB_DEFS.happy_ghast.hp, attackCd: 0, onGround: false,
    wanderDir: 0, wanderTimer: 0, wanderMoving: false,
    fleeTimer: 0, fleeFromX: 0, fleeFromZ: 0, arrowCd: 1, ignite: -1,
  };
}

beforeEach(() => {
  clearMobs();
  clearDrops();
  clearGrowthAges();
  weather.kind = 'clear';
  worldClock.t = 0.3; // 白天
});

describe('干恶魂方块与获取', () => {
  it('方块注册：id 追加在注册表末尾（存档兼容）、canvas 图标格 +34、挖掘掉落自身', () => {
    const d = BLOCK_BY_KEY.dried_ghast;
    expect(d).toBeDefined();
    expect(d.id).toBe(BLOCKS.length - 1);
    expect(d.name).toBe('干恶魂');
    expect(d.top).toBe(ICON_TILE_START + 34);
    expect(d.side).toBe(ICON_TILE_START + 34);
    expect(d.bottom).toBe(ICON_TILE_START + 34);
    expect(ICON_TILE_START + 34).toBeLessThan(ICON_TILE_START + ICON_TILE_COUNT); // 图标区容量内
    expect(d.solid).toBe(true);
    expect(d.dropBlock).toBeUndefined(); // 默认方块掉落 = 掉自身
    expect(d.nonSilkDrop).toBeUndefined();
  });

  it('合成配方：灵魂沙×1 居中 + 恶魂之泪×8 围圈（工作台，1.21.6 Java 配方）', () => {
    const r = RECIPES.find((x) => x.id === 'dried_ghast')!;
    expect(r.out).toEqual({ kind: 'block', id: BLOCK_BY_KEY.dried_ghast.id, count: 1 });
    expect(r.cost).toContainEqual({ item: 'material:ghast_tear', count: 8 });
    expect(r.cost).toContainEqual({ item: `block:${BLOCK_BY_KEY.soul_sand.id}`, count: 1 });
    expect(r.needsTable).toBe(true);
    const pat = recipePattern(r);
    expect(pat[4]).toBe(`block:${BLOCK_BY_KEY.soul_sand.id}`); // 灵魂沙居中
    expect(pat.filter((c) => c === 'material:ghast_tear')).toHaveLength(8);
  });

  it('以物易物表含干恶魂（低权重），权重和保持 100', () => {
    const entry = BARTER_TABLE.find((c) => c.key === 'dried_ghast');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('block');
    expect(entry!.count).toEqual([1, 1]);
    expect(entry!.weight).toBeLessThanOrEqual(5); // 小概率
    expect(BARTER_TABLE.reduce((n, c) => n + c.weight, 0)).toBe(100);
  });
});

describe('鞍具物品与配方', () => {
  it('材料信息已登记（recipes.ts 增广）：名称 + canvas 图标格 +35', () => {
    expect(MATERIAL_INFO.harness.name).toBe('鞍具');
    expect(MATERIAL_INFO.harness.tile).toBe(ICON_TILE_START + 35);
    expect(ICON_TILE_START + 35).toBeLessThan(ICON_TILE_START + ICON_TILE_COUNT);
  });

  it('配方：皮革×3 + 玻璃×2 + 白色羊毛×1（工作台，1.21.6 Java 配方），可实际合成', () => {
    const r = RECIPES.find((x) => x.id === 'harness')!;
    expect(r.out).toEqual({ kind: 'material', material: 'harness', count: 1 });
    expect(r.cost).toContainEqual({ item: 'material:leather', count: 3 });
    expect(r.cost).toContainEqual({ item: `block:${BLOCK_BY_KEY.glass.id}`, count: 2 });
    expect(r.cost).toContainEqual({ item: `block:${BLOCK_BY_KEY.white_wool.id}`, count: 1 });
    expect(r.needsTable).toBe(true);
    const slots: Slot[] = [
      { kind: 'material', material: 'leather', count: 3 },
      { kind: 'block', id: BLOCK_BY_KEY.glass.id, count: 2 },
      { kind: 'block', id: BLOCK_BY_KEY.white_wool.id, count: 1 },
      null,
    ];
    expect(canCraft(slots, r)).toBe(true);
    const next = applyCraft(slots, r, 0);
    const out = next.find((s) => s?.kind === 'material' && s.material === 'harness');
    expect(out).toMatchObject({ kind: 'material', material: 'harness', count: 1 });
    expect(next.every((s) => s === null || (s.kind === 'material' && s.material === 'harness'))).toBe(true); // 材料全耗净
  });
});

describe('干恶魂泡水复水（growth.ts）', () => {
  it('泡水约 20 分钟孵出小恶魂并消耗方块；离水暂停计时', () => {
    const w = voidWorld();
    const dried = BLOCK_BY_KEY.dried_ghast.id;
    w.setBlock(4, 40, 4, dried);
    trackDriedGhast(4, 40, 4);
    // 离水：推进 100s 无进展
    tickGrowth(w, 100);
    expect(rehydrationLeft(4, 40, 4)).toBe(DRIED_GHAST_REHYDRATE_SECONDS);
    expect(w.getBlock(4, 40, 4)).toBe(dried);
    // 邻格放水：开始倒计时
    w.setBlock(5, 40, 4, BLOCK_BY_KEY.water.id);
    tickGrowth(w, 100);
    expect(rehydrationLeft(4, 40, 4)).toBeCloseTo(DRIED_GHAST_REHYDRATE_SECONDS - 100, 5);
    // 泡满全程：方块消耗，孵出小恶魂（幼体 + 成长计时）
    tickGrowth(w, DRIED_GHAST_REHYDRATE_SECONDS);
    expect(w.getBlock(4, 40, 4)).toBe(AIR);
    expect(rehydrationLeft(4, 40, 4)).toBeUndefined();
    const g = mobs.find((m) => m.type === 'ghastling');
    expect(g).toBeDefined();
    expect(g!.baby).toBe(true);
    expect(g!.growUp).toBe(GHASTLING_GROW_SECONDS);
  });

  it('方块被挖掉：复水登记除名，不再孵化', () => {
    const w = voidWorld();
    const dried = BLOCK_BY_KEY.dried_ghast.id;
    w.setBlock(8, 40, 8, dried);
    w.setBlock(9, 40, 8, BLOCK_BY_KEY.water.id);
    trackDriedGhast(8, 40, 8);
    tickGrowth(w, 100);
    expect(rehydrationLeft(8, 40, 8)).toBeLessThan(DRIED_GHAST_REHYDRATE_SECONDS);
    w.setBlock(8, 40, 8, AIR); // 挖掉
    tickGrowth(w, 1);
    expect(rehydrationLeft(8, 40, 8)).toBeUndefined();
    tickGrowth(w, DRIED_GHAST_REHYDRATE_SECONDS);
    expect(mobs.some((m) => m.type === 'ghastling')).toBe(false);
  });

  it('喂雪球加速复水：每颗 -60s（项目约定；未登记返回 false）', () => {
    trackDriedGhast(12, 40, 12);
    expect(accelerateDriedGhast(12, 40, 12)).toBe(true);
    expect(rehydrationLeft(12, 40, 12)).toBe(DRIED_GHAST_REHYDRATE_SECONDS - SNOWBALL_REHYDRATE_BOOST);
    expect(accelerateDriedGhast(0, 0, 0)).toBe(false);
  });
});

describe('小恶魂长大（mobs.ts growUp 转化）', () => {
  it('20 分钟长成快乐恶魂；喂雪球每次加速 1/10', () => {
    const w = voidWorld();
    const g = spawnGhastling(8.5, 50, 8.5);
    expect(g.type).toBe('ghastling');
    expect(g.growUp).toBe(GHASTLING_GROW_SECONDS);
    feedSnowball(g);
    expect(g.growUp).toBe(GHASTLING_GROW_SECONDS - SNOWBALL_GROWTH_BOOST);
    expect(SNOWBALL_GROWTH_BOOST).toBe(GHASTLING_GROW_SECONDS / 10);
    // 推满剩余时间：type 转化为 happy_ghast
    g.growUp = 1;
    for (let i = 0; i < 20 && g.type === 'ghastling'; i++) tickMobs(w, 0.1, { x: 200, y: 50, z: 200 }, () => undefined);
    expect(g.type).toBe('happy_ghast');
    expect(g.baby).toBe(false);
    expect(g.growUp).toBeUndefined();
  });

  it('喂雪球回血（快乐恶魂）：+4 不超上限；小恶魂/快乐恶魂不繁殖（不进 BREED_FOOD）', () => {
    const g = mkHappy(8.5, 50, 8.5);
    g.hp = 10;
    feedSnowball(g);
    expect(g.hp).toBe(14);
    g.hp = 19;
    feedSnowball(g);
    expect(g.hp).toBe(20); // 封顶
    expect(BREED_FOOD.ghastling).toBeUndefined();
    expect(BREED_FOOD.happy_ghast).toBeUndefined();
  });
});

describe('快乐恶魂行为', () => {
  it('被动：不攻击玩家、无掉落攻击物；悬浮不坠', () => {
    expect(MOB_DEFS.happy_ghast.hostile).toBe(false);
    expect(MOB_DEFS.happy_ghast.damage).toBe(0);
    expect(MOB_DEFS.happy_ghast.drops).toHaveLength(0);
    expect(MOB_DEFS.ghastling.hostile).toBe(false);
    expect(MOB_DEFS.ghastling.drops).toHaveLength(0);
    const w = voidWorld();
    const player = { x: 8.5, y: 50, z: 8.5 };
    const g = mkHappy(11.5, 50, 8.5);
    mobs.push(g);
    const y0 = g.y;
    let dmg = 0;
    for (let i = 0; i < 30; i++) tickMobs(w, 0.1, player, (d) => (dmg += d));
    expect(dmg).toBe(0);
    expect(Math.abs(g.y - y0)).toBeLessThan(2); // 悬浮不坠
  });

  it('雪球/鞍具引诱：手持雪球时快乐恶魂跟着走；小恶魂 16 格内跟随玩家', () => {
    expect(TEMPT_FOOD.happy_ghast).toContain('snowball');
    expect(TEMPT_FOOD.happy_ghast).toContain('harness');
    expect(TEMPT_FOOD.ghastling).toContain('snowball');
    const w = voidWorld();
    const player = { x: 8.5, y: 50, z: 8.5 };
    const g = mkHappy(15.5, 50, 8.5); // 7 格外
    mobs.push(g);
    const x0 = g.x;
    for (let i = 0; i < 20; i++) tickMobs(w, 0.1, player, () => undefined, 'snowball');
    expect(g.x).toBeLessThan(x0); // 被雪球引诱靠近
    // 小恶魂跟随（无需手持物）
    const gl = spawnGhastling(14.5, 50, 8.5); // 6 格外
    const gx0 = gl.x;
    for (let i = 0; i < 20; i++) tickMobs(w, 0.1, player, () => undefined);
    expect(gl.x).toBeLessThan(gx0);
  });

  it('被骑乘（riddenByPlayer）：AI/引诱/悬浮/重力冻结，位置保持（骑乘系统对接字段）', () => {
    const w = voidWorld();
    const g = mkHappy(8.5, 50, 8.5);
    g.riddenByPlayer = true;
    mobs.push(g);
    const player = { x: 8.5, y: 50, z: 8.5 };
    for (let i = 0; i < 30; i++) tickMobs(w, 0.1, player, () => undefined, 'snowball'); // 手持雪球也不该被引诱
    expect(g.x).toBe(8.5);
    expect(g.y).toBe(50);
    expect(g.z).toBe(8.5);
  });

  it('缓慢回血：晴天 20s 回 1 点；露天淋雨加倍', () => {
    const w = voidWorld();
    const player = { x: 200, y: 50, z: 200 };
    const g = mkHappy(8.5, 60, 8.5);
    g.hp = 10;
    mobs.push(g);
    for (let i = 0; i < 210; i++) tickMobs(w, 0.1, player, () => undefined); // 21s 晴天 ≈ +1
    expect(g.hp).toBe(11);
    weather.kind = 'rain'; // VOID_TERRAIN 平原 → 降雨（非雪）
    for (let i = 0; i < 210; i++) tickMobs(w, 0.1, player, () => undefined); // 21s 雨天 ≈ +2
    expect(g.hp).toBe(13);
    weather.kind = 'clear';
  });
});

describe('鞍具装备/卸下（骑乘系统对接字段 harnessed）', () => {
  it('装备/卸下/规则校验', () => {
    const g = mkHappy(8.5, 50, 8.5);
    mobs.push(g);
    expect(equipHarness(g)).toBe(true);
    expect(g.harnessed).toBe(true);
    expect(equipHarness(g)).toBe(false); // 已装备不可重复
    expect(unequipHarness(g)).toBe(true);
    expect(g.harnessed).toBe(false);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'harness')).toBe(true); // 卸下掉回物品
    expect(unequipHarness(g)).toBe(false); // 未装备不可卸
    // 非快乐恶魂不可装备（小恶魂也不行，Java）
    const gl = spawnGhastling(8.5, 50, 8.5);
    expect(equipHarness(gl)).toBe(false);
  });

  it('死亡掉回鞍具（本体不掉落攻击物）', () => {
    const w = voidWorld();
    const g = mkHappy(8.5, 50, 8.5);
    mobs.push(g);
    equipHarness(g);
    expect(damageMob(g, 999, { x: 0, z: 0 }, 0, w)).toBe(true);
    expect(g.harnessed).toBe(false);
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'harness')).toBe(true);
    // 除鞍具外无任何材料掉落（不掉落攻击物）
    expect(itemDrops.filter((d) => d.drop.kind === 'material' && d.drop.material !== 'harness')).toHaveLength(0);
  });
});
