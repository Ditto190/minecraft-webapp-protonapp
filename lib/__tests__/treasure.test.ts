// 沉船 → 藏宝图 → 埋藏的宝藏 链条：海岸宝藏生成、沉船三箱（地图箱必出藏宝图）、藏宝图导航指向与已开跳过

import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY } from '../blocks';
import { createTerrain, hashString, SEA_LEVEL, type Terrain } from '../noise';
import { clearStorages, getStorage } from '../storage';
import {
  applyStructures,
  buriedTreasureChest,
  markTreasureOpened,
  nearestBuriedTreasure,
  openedTreasures,
  structureAt,
  type StructureSpot,
} from '../structures';
import { CHUNK_SIZE, CHUNK_VOLUME, localIndex } from '../grid';

const K = (k: string) => BLOCK_BY_KEY[k].id;

const mockTerrain = (heightAt: (x: number, z: number) => number, biome: 'ocean' | 'plains'): Terrain => ({
  heightAt,
  biomeAt: () => biome,
  treeAt: () => null,
  caveAt: () => false,
  snowlineAt: () => Infinity,
  undergroundAt: () => null,
  aquiferAt: () => false,
});

/** 海床（沉船门：h ≤ SEA_LEVEL-2 且不够深海遗迹的 -10） */
const OCEAN = mockTerrain(() => SEA_LEVEL - 6, 'ocean');
/** 海岸线 x=40：西侧滩涂（SEA_LEVEL+1）、东侧海（SEA_LEVEL-8）——区域中心仅在 rx=0 一列落在海岸带 */
const COAST = mockTerrain((x) => (x < 40 ? SEA_LEVEL + 1 : SEA_LEVEL - 8), 'plains');

function findSpots(seedHash: number, t: Terrain, kind: string, limit = 1): StructureSpot[] {
  const out: StructureSpot[] = [];
  for (let rx = -30; rx < 60 && out.length < limit; rx++) {
    for (let rz = -30; rz < 60 && out.length < limit; rz++) {
      const s = structureAt(seedHash, t, rx, rz);
      if (s?.kind === kind) out.push(s);
    }
  }
  if (out.length < limit) throw new Error(`未找到足够的 ${kind}（${out.length}/${limit}）`);
  return out;
}

/** 生成中心点周围 4×4 chunk（各自独立数组），返回跨 chunk 读格函数（范围外返回 -1） */
function genAround(seedHash: number, t: Terrain, x: number, z: number): (x: number, y: number, z: number) => number {
  const chunks = new Map<string, Uint16Array>();
  const ccx = Math.floor(x / CHUNK_SIZE);
  const ccz = Math.floor(z / CHUNK_SIZE);
  for (let cx = ccx - 2; cx <= ccx + 1; cx++) {
    for (let cz = ccz - 2; cz <= ccz + 1; cz++) {
      const data = new Uint16Array(CHUNK_VOLUME);
      applyStructures(seedHash, t, cx, cz, data);
      chunks.set(`${cx},${cz}`, data);
    }
  }
  return (wx, wy, wz) => {
    const data = chunks.get(`${Math.floor(wx / CHUNK_SIZE)},${Math.floor(wz / CHUNK_SIZE)}`);
    if (!data) return -1;
    return data[localIndex(wx - Math.floor(wx / CHUNK_SIZE) * CHUNK_SIZE, wy, wz - Math.floor(wz / CHUNK_SIZE) * CHUNK_SIZE)];
  };
}

beforeEach(() => {
  clearStorages();
  openedTreasures.clear();
});

describe('埋藏的宝藏（海岸带稀有生成）', () => {
  it('海岸带区域判定：只在滩涂高度带 + 近海处生成', () => {
    const sh = hashString('treasure-coast-gate');
    // COAST 下只有 rx=0 一列是海岸带；找到的全部宝藏都应在该列且贴近海平面
    const spots = findSpots(sh, COAST, 'buried_treasure', 5);
    for (const s of spots) {
      expect(s.x).toBe(32); // rx=0 → x = 0*64+32
      const h = COAST.heightAt(s.x, s.z);
      expect(h).toBeGreaterThanOrEqual(SEA_LEVEL - 1);
      expect(h).toBeLessThanOrEqual(SEA_LEVEL + 3);
    }
    // 纯内陆 mock（永远 SEA_LEVEL+1，无海）不出宝藏
    const INLAND = mockTerrain(() => SEA_LEVEL + 1, 'plains');
    for (let rx = 0; rx < 20; rx++) {
      for (let rz = 0; rz < 20; rz++) {
        expect(structureAt(sh, INLAND, rx, rz)?.kind).not.toBe('buried_treasure');
      }
    }
  });

  it('真实种子海岸生成宝藏：地下 1-3 格埋 1 个宝箱，战利品为 Java 对齐组合', () => {
    const t = createTerrain('treasure-real');
    const sh = hashString('treasure-real');
    const [spot] = findSpots(sh, t, 'buried_treasure');
    const c = buriedTreasureChest(sh, t, spot);
    // 埋深 1-3 格（箱顶之上是地表方块）
    const h = t.heightAt(spot.x, spot.z);
    expect(h - c.y).toBeGreaterThanOrEqual(1);
    expect(h - c.y).toBeLessThanOrEqual(3);
    // 生成后该格为宝箱
    const at = genAround(sh, t, c.x, c.z);
    expect(at(c.x, c.y, c.z)).toBe(K('chest'));
    // 战利品：只含 TREASURE_LOOT 声明的材料或 TNT 方块（海洋之心项目未做，注释见 structures.ts）
    const loot = getStorage(`${c.x},${c.y},${c.z}`);
    const allowed = new Set(['iron_ingot', 'gold_ingot', 'cooked_salmon', 'prismarine_crystals', 'diamond']);
    for (const s of loot) {
      if (!s) continue;
      if (s.kind === 'material') expect(allowed.has(s.material)).toBe(true);
      else if (s.kind === 'block') expect(s.id).toBe(K('tnt'));
    }
    expect(loot.some((s) => s !== null)).toBe(true);
  });
});

describe('沉船三箱（Java：补给/地图/宝藏箱）', () => {
  it('地图箱（尾舱）必出藏宝图；船头补给箱与主舱宝藏箱存在', () => {
    const sh = hashString('treasure-ship');
    const [spot] = findSpots(sh, OCEAN, 'shipwreck');
    const by = OCEAN.heightAt(spot.x, spot.z) + 1;
    const at = genAround(sh, OCEAN, spot.x, spot.z);
    // 三个宝箱方块就位
    expect(at(spot.x + 3, by + 3, spot.z)).toBe(K('chest')); // 尾舱地图箱
    expect(at(spot.x - 3, by + 3, spot.z)).toBe(K('chest')); // 船头补给箱
    expect(at(spot.x, by + 1, spot.z)).toBe(K('chest')); // 主舱甲板下宝藏箱
    // 地图箱必出藏宝图（Java 规则）
    const mapLoot = getStorage(`${spot.x + 3},${by + 3},${spot.z}`);
    expect(mapLoot.some((s) => s?.kind === 'material' && s.material === 'treasure_map')).toBe(true);
    // 地图箱不含原 SHIP_LOOT 池（已换成 SHIP_MAP_LOOT），补给/宝藏箱仍用 SHIP_LOOT
    expect(mapLoot.some((s) => s?.kind === 'material' && s.material === 'leather')).toBe(false);
    const supplyLoot = getStorage(`${spot.x - 3},${by + 3},${spot.z}`);
    const hullLoot = getStorage(`${spot.x},${by + 1},${spot.z}`);
    expect(supplyLoot.some((s) => s !== null) || hullLoot.some((s) => s !== null)).toBe(true);
    for (const s of [...supplyLoot, ...hullLoot]) {
      if (s?.kind === 'material') expect(s.material).not.toBe('treasure_map');
    }
  });
});

describe('藏宝图导航（最近未开启宝藏）', () => {
  it('指向最近宝藏箱坐标；开启后跳过指向下一个；全部开启返回 null', () => {
    const sh = hashString('treasure-nav');
    const [a, b] = findSpots(sh, COAST, 'buried_treasure', 2);
    const gap = Math.abs(a.z - b.z) / 64; // 两处宝藏的区域间距
    const maxR = gap + 2;
    const chestA = buriedTreasureChest(sh, COAST, a);
    const chestB = buriedTreasureChest(sh, COAST, b);
    // 站在 A 旁边：指向 A 的箱坐标（精确断言）
    const near = nearestBuriedTreasure(sh, COAST, a.x - 10, a.z + 5, maxR);
    expect(near).toEqual(chestA);
    // 开启 A 后：跳过 A 指向 B
    markTreasureOpened(sh, COAST, chestA.x, chestA.y, chestA.z);
    expect(nearestBuriedTreasure(sh, COAST, a.x - 10, a.z + 5, maxR)).toEqual(chestB);
    // B 也开启后：扫描范围内不再有目标（范围内其余宝藏一并标开，验证 null 分支）
    const rx0 = Math.floor((a.x - 10) / 64);
    const rz0 = Math.floor((a.z + 5) / 64);
    for (let drx = -maxR; drx <= maxR; drx++) {
      for (let drz = -maxR; drz <= maxR; drz++) {
        const s = structureAt(sh, COAST, rx0 + drx, rz0 + drz);
        if (s?.kind === 'buried_treasure') {
          const c = buriedTreasureChest(sh, COAST, s);
          markTreasureOpened(sh, COAST, c.x, c.y, c.z);
        }
      }
    }
    expect(nearestBuriedTreasure(sh, COAST, a.x - 10, a.z + 5, maxR)).toBeNull();
  });

  it('markTreasureOpened 只认宝藏箱坐标（普通箱子/偏移坐标不误标）', () => {
    const sh = hashString('treasure-nav');
    const [a] = findSpots(sh, COAST, 'buried_treasure', 1);
    const c = buriedTreasureChest(sh, COAST, a);
    markTreasureOpened(sh, COAST, c.x + 1, c.y, c.z); // 旁边一格不是宝藏箱
    markTreasureOpened(sh, COAST, c.x, c.y + 1, c.z); // 箱顶地表也不是
    expect(openedTreasures.size).toBe(0);
    markTreasureOpened(sh, COAST, c.x, c.y, c.z);
    expect(openedTreasures.size).toBe(1);
  });
});
