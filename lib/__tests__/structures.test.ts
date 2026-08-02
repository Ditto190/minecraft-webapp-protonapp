import { describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, GLASS, GRASS, LOG, PLANKS } from '../blocks';
import { createTerrain, hashString, type Terrain } from '../noise';
import { getStorage } from '../storage';
import { applyStructures, structureAt, villageAt, villageStructures } from '../structures';
import { CHUNK_SIZE, WORLD_HEIGHT, localIndex } from '../world';

const SEED = 'village-test';

function findVillageRegion(seedHash: number, terrain: Terrain): { rx: number; rz: number } {
  for (let rx = -20; rx < 20; rx++) {
    for (let rz = -20; rz < 20; rz++) {
      if (villageAt(seedHash, terrain, rx, rz)) return { rx, rz };
    }
  }
  throw new Error('该种子在 ±20 区域内没有村庄');
}

describe('村庄结构', () => {
  it('村庄判定确定性一致', () => {
    const t = createTerrain(SEED);
    const sh = hashString(SEED);
    expect(villageAt(sh, t, 3, -2)).toEqual(villageAt(sh, t, 3, -2));
  });

  it('布局确定性：中心水井 + 至少 3 栋小屋', () => {
    const t = createTerrain(SEED);
    const sh = hashString(SEED);
    const { rx, rz } = findVillageRegion(sh, t);
    const v = villageAt(sh, t, rx, rz)!;
    const s1 = villageStructures(sh, rx, rz, v.x, v.z);
    const s2 = villageStructures(sh, rx, rz, v.x, v.z);
    expect(s1).toEqual(s2);
    expect(s1[0].type).toBe('well');
    expect(s1.filter((s) => s.type === 'hut').length).toBeGreaterThanOrEqual(3);
  });

  it('小屋写入正确方块：原木角柱、木板顶、门洞为空', () => {
    const t = createTerrain(SEED);
    const sh = hashString(SEED);
    const { rx, rz } = findVillageRegion(sh, t);
    const v = villageAt(sh, t, rx, rz)!;
    const hut = villageStructures(sh, rx, rz, v.x, v.z).find((s) => s.type === 'hut')!;
    const h = t.heightAt(hut.x, hut.z);
    // 角柱可能跨到相邻 chunk：对小屋所在 chunk 与角柱所在 chunk 分别生成并断言
    const genAt = (wx: number, wz: number) => {
      const cx = Math.floor(wx / CHUNK_SIZE);
      const cz = Math.floor(wz / CHUNK_SIZE);
      const data = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) data[localIndex(x, h, z)] = GRASS;
      }
      applyStructures(sh, t, cx, cz, data);
      return (x: number, y: number, z: number) => data[localIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
    };
    expect(genAt(hut.x - 2, hut.z - 2)(hut.x - 2, h + 2, hut.z - 2)).toBe(LOG); // 角柱（地板在 h+1，墙从 h+2 起）
    expect(genAt(hut.x, hut.z)(hut.x, h + 5, hut.z)).toBe(PLANKS); // 屋顶
    expect(genAt(hut.x, hut.z + 2)(hut.x, h + 2, hut.z + 2)).toBe(0); // 门洞（南墙中央）
    expect(genAt(hut.x - 2, hut.z)(hut.x - 2, h + 3, hut.z)).toBe(GLASS); // 西墙玻璃窗
  });
});

describe('冰屋地下室（Java：50% 冰屋带地下室）', () => {
  const K = (k: string) => BLOCK_BY_KEY[k].id;
  const SNOWY: Terrain = {
    heightAt: () => 45,
    biomeAt: () => 'snowy',
    treeAt: () => null,
    caveAt: () => false,
    snowlineAt: () => Infinity,
    undergroundAt: () => null,
    aquiferAt: () => false,
  };

  function findIgloo(seedHash: number, basement: boolean): { x: number; z: number } {
    for (let rx = 0; rx < 40; rx++) {
      for (let rz = 0; rz < 40; rz++) {
        const s = structureAt(seedHash, SNOWY, rx, rz);
        if (s?.kind === 'igloo' && !!s.basement === basement) return s;
      }
    }
    throw new Error(`未找到 basement=${basement} 的冰屋`);
  }

  /** 生成冰屋中心周围 chunk（覆盖穹顶与地下室范围：结构中心局部坐标恒为 0，地下室向北伸 19 格），返回跨 chunk 读格函数 */
  function genAround(seedHash: number, spot: { x: number; z: number }): (x: number, y: number, z: number) => number {
    const chunks = new Map<string, Uint16Array>();
    const ccx = Math.floor(spot.x / CHUNK_SIZE);
    const ccz = Math.floor(spot.z / CHUNK_SIZE);
    for (let cx = ccx - 2; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 2; cz <= ccz + 1; cz++) {
        const data = new Uint16Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
        applyStructures(seedHash, SNOWY, cx, cz, data);
        chunks.set(`${cx},${cz}`, data);
      }
    }
    return (x, y, z) => {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      const data = chunks.get(`${cx},${cz}`);
      if (!data) return -1; // 范围外
      return data[localIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
    };
  }

  it('约半数冰屋带地下室（区域哈希 50% 门）', () => {
    const sh = hashString('igloo-rate');
    let total = 0;
    let withBasement = 0;
    for (let rx = 0; rx < 30; rx++) {
      for (let rz = 0; rz < 30; rz++) {
        const s = structureAt(sh, SNOWY, rx, rz);
        if (s?.kind !== 'igloo') continue;
        total++;
        if (s.basement) withBasement++;
      }
    }
    expect(total).toBeGreaterThan(10);
    expect(withBasement).toBeGreaterThan(0);
    expect(withBasement).toBeLessThan(total);
  });

  it('带地下室冰屋：穹顶下踏步竖井通石砖密室（宝箱含金苹果 + 酿造台 + 床）', () => {
    const sh = hashString('igloo-basement');
    const spot = findIgloo(sh, true);
    const at = genAround(sh, spot);
    const by = 46; // heightAt 45 + 1
    // 穹顶仍在
    expect(at(spot.x, by + 4, spot.z)).toBe(K('snow_block'));
    // 密室墙体为石砖系（地板/天花石砖，墙混苔石砖/裂纹石砖）
    const y0 = by - 13;
    const wallId = at(spot.x - 3, y0 + 2, spot.z - 16);
    expect([K('stone_bricks'), K('mossy_stone_bricks'), K('cracked_stone_bricks')]).toContain(wallId);
    // 密室内空 + 内容物
    expect(at(spot.x, y0 + 2, spot.z - 16)).toBe(AIR);
    expect(at(spot.x - 1, y0 + 1, spot.z - 18)).toBe(K('chest'));
    expect(at(spot.x + 1, y0 + 1, spot.z - 18)).toBe(K('brewing_stand'));
    expect(at(spot.x - 2, y0 + 1, spot.z - 15)).toBe(K('red_bed'));
    // 竖井：穹顶地板有开口，踏步一路向下到密室（中点格为空）
    expect(at(spot.x, by, spot.z - 2)).toBe(AIR);
    expect(at(spot.x, by - 6, spot.z - 7)).toBe(AIR);
    expect(at(spot.x, by - 12, spot.z - 13)).toBe(AIR);
    // 宝箱战利品：Java 冰屋地下室必有金苹果
    const loot = getStorage(`${spot.x - 1},${y0 + 1},${spot.z - 18}`);
    expect(loot.some((s) => s?.kind === 'material' && s.material === 'golden_apple')).toBe(true);
  });

  it('不带地下室的冰屋：只有穹顶，地下无密室', () => {
    const sh = hashString('igloo-basement');
    const spot = findIgloo(sh, false);
    const at = genAround(sh, spot);
    const y0 = 46 - 13;
    expect(at(spot.x - 1, y0 + 1, spot.z - 18)).not.toBe(K('chest'));
    expect(at(spot.x + 1, y0 + 1, spot.z - 18)).not.toBe(K('brewing_stand'));
  });
});
