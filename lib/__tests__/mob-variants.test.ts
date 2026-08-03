// 动物群系变种（1.21.5 Spring to Life，MC）：牛/猪/鸡按出生地群系温度分 cold/temperate/warm——
// 寒带（雪原/冰刺/针叶林）出 cold、热带（沙漠/热带草原/丛林）出 warm、其余 temperate；
// 繁殖后代随机继承双亲之一；覆雪草方块也是草地（雪原同样刷农场动物）

import { beforeEach, describe, expect, it } from 'vitest';
import { worldClock } from '../game';
import { breedMob, clearMobs, mobs, MOB_DEFS, trySpawn, variantForBiome, type AnimalVariant, type Mob, type MobType } from '../mobs';
import { VOID_TERRAIN, type Biome } from '../noise';
import { weather } from '../weather';
import { World } from '../world';

const FARM: readonly MobType[] = ['cow', 'pig', 'chicken'];

function mkMob(type: MobType, variant?: AnimalVariant): Mob {
  return {
    id: Math.random(),
    type, x: 0, y: 41, z: 0,
    velY: 0, hp: MOB_DEFS[type].hp, attackCd: 0, onGround: true,
    wanderDir: 0, wanderTimer: 0, wanderMoving: false,
    fleeTimer: 0, fleeFromX: 0, fleeFromZ: 0,
    arrowCd: 1, ignite: -1,
    variant,
  };
}

/** 固定群系的平地世界（地表 y=45；刷怪环带 ±48 格已预载） */
function farmWorld(biome: Biome): World {
  const w = new World(`variant-${biome}`, undefined, { ...VOID_TERRAIN, heightAt: () => 45, biomeAt: () => biome });
  for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) w.getChunk(cx, cz);
  return w;
}

beforeEach(() => {
  clearMobs();
  worldClock.t = 0.3; // 白天：刷被动
  weather.kind = 'clear';
});

describe('variantForBiome 群系-变种映射', () => {
  it('寒带群系 cold / 热带群系 warm / 其余 temperate', () => {
    for (const b of ['snowy', 'ice_spikes', 'taiga'] as const) expect(variantForBiome(b), b).toBe('cold');
    for (const b of ['desert', 'savanna', 'jungle'] as const) expect(variantForBiome(b), b).toBe('warm');
    for (const b of ['plains', 'forest', 'birch_forest', 'dark_forest', 'swamp', 'badlands', 'mountains', 'mushroom_fields', 'ocean', 'river', 'basin'] as const) {
      expect(variantForBiome(b), b).toBe('temperate');
    }
  });
});

describe('自然生成按出生地群系定变种（trySpawn 接线）', () => {
  it.each<[Biome, AnimalVariant]>([
    ['taiga', 'cold'],
    ['snowy', 'cold'], // 覆雪草方块也是草地（MC 雪原也刷农场动物）
    ['savanna', 'warm'],
    ['jungle', 'warm'],
    ['plains', 'temperate'],
    ['forest', 'temperate'],
  ])('%s 群系刷出的牛/猪/鸡全为 %s 变种', (biome, want) => {
    const w = farmWorld(biome);
    let farm = 0;
    for (let i = 0; i < 300 && farm < 6; i++) {
      trySpawn(w, 8.5, 8.5);
      for (const m of mobs) {
        if (!FARM.includes(m.type)) continue;
        expect(m.variant, `${biome} 的 ${m.type}`).toBe(want);
        farm++;
      }
      clearMobs(); // 被动上限 6：清空继续刷
    }
    expect(farm, `${biome} 应能刷出农场动物`).toBeGreaterThan(0);
  });

  it('敌对/其他物种不携带变种', () => {
    const w = farmWorld('taiga');
    for (let i = 0; i < 60; i++) {
      trySpawn(w, 8.5, 8.5);
      for (const m of mobs) {
        if (FARM.includes(m.type)) continue;
        expect(m.variant, m.type).toBeUndefined();
      }
      clearMobs();
    }
  });
});

describe('繁殖变种遗传（MC：双亲不同变种时随机取一方）', () => {
  it('双亲同变种 → 幼体恒为该变种', () => {
    const a = mkMob('cow', 'cold');
    const b = mkMob('cow', 'cold');
    for (let i = 0; i < 8; i++) expect(breedMob(a, b).variant).toBe('cold');
    const w1 = mkMob('chicken', 'warm');
    const w2 = mkMob('chicken', 'warm');
    expect(breedMob(w1, w2).variant).toBe('warm');
  });

  it('双亲不同变种 → 幼体随机取一方', () => {
    const a = mkMob('pig', 'cold');
    const b = mkMob('pig', 'warm');
    const seen = new Set<AnimalVariant>();
    for (let i = 0; i < 60; i++) {
      const v = breedMob(a, b).variant;
      expect(v === 'cold' || v === 'warm').toBe(true);
      seen.add(v!);
    }
    expect(seen.size).toBe(2); // 60 次双亲各出现（同取一方概率 2^-59，不会偶发）
  });

  it('无变种信息的双亲（旧存档/鸡蛋孵化）→ 温带兜底；单亲信息按亲代', () => {
    expect(breedMob(mkMob('chicken')).variant).toBe('temperate');
    expect(breedMob(mkMob('cow', 'warm')).variant).toBe('warm');
  });

  it('非变种物种繁殖不携带变种', () => {
    expect(breedMob(mkMob('sheep')).variant).toBeUndefined();
  });
});
