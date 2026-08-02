// 主世界复刻专项：山地雪线/雪顶、矿石 MC 分布（绿宝石仅山地、恶地金矿、深层变体）、
// 标志植被（仙人掌/甘蔗/巨蘑菇）、恶地陶瓦地层、树形库、存档版本

import { describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, BLOCKS } from '../blocks';
import { createTerrain, SEA_LEVEL, type Terrain, type TreeKind } from '../noise';
import { applyAirExposure, applyOres } from '../oregen';
import { SAVE_VERSION } from '../persistence';
import { isLeavesId, leafDistanceToLog } from '../saplings';
import { writeTree } from '../trees';
import { CHUNK_VOLUME, localIndex, World } from '../world';

const K = (k: string) => BLOCK_BY_KEY[k].id;

/** 收集 chunk 中所有 id（含坐标） */
function cells(data: Uint16Array): { x: number; y: number; z: number; id: number }[] {
  const out: { x: number; y: number; z: number; id: number }[] = [];
  for (let y = 0; y < 128; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const id = data[localIndex(x, y, z)];
        if (id !== AIR) out.push({ x, y, z, id });
      }
    }
  }
  return out;
}

const mockTerrain = (over: Partial<Terrain>): Terrain => ({
  heightAt: () => 45,
  biomeAt: () => 'plains',
  treeAt: () => null,
  caveAt: () => false,
  snowlineAt: () => Infinity,
  undergroundAt: () => null,
  aquiferAt: () => false,
  ...over,
});

describe('山地与雪线', () => {
  it('真实地形存在山地群系且雪线有限，雪线以上地表为雪块', () => {
    const t = createTerrain('mt-seed');
    let peaks = 0;
    let snowTop = 0;
    const w = new World('mt-seed');
    for (let x = -800; x < 800 && peaks < 12; x += 3) {
      for (let z = -800; z < 800 && peaks < 12; z += 3) {
        const h = t.heightAt(x, z);
        if (t.biomeAt(x, z) !== 'mountains') continue;
        const sl = t.snowlineAt(x, z);
        expect(sl).not.toBe(Infinity);
        if (h < sl) continue;
        peaks++;
        // 雪线以上的峰顶：雪块或石头（洞穴可能局部雕空，苔藓/草不可能）
        const topId = w.getBlock(x, h, z);
        if (topId === K('snow_block')) snowTop++;
        expect([K('snow_block'), K('stone'), AIR]).toContain(topId);
      }
    }
    expect(peaks).toBeGreaterThan(3);
    expect(snowTop).toBeGreaterThan(0);
  });

  it('雪线以上不长树', () => {
    const t = createTerrain('mt-seed');
    for (let x = -800; x < 800; x += 2) {
      for (let z = -800; z < 800; z += 2) {
        if (t.biomeAt(x, z) !== 'mountains') continue;
        const h = t.heightAt(x, z);
        if (h >= t.snowlineAt(x, z)) expect(t.treeAt(x, z)).toBeNull();
      }
    }
  });
});

describe('矿石 MC 分布', () => {
  const oreChunks = (biome: ReturnType<Terrain['biomeAt']>, n = 8) => {
    const found: { y: number; id: number }[] = [];
    for (let c = 0; c < n; c++) {
      const data = new Uint16Array(CHUNK_VOLUME);
      data.fill(K('stone'));
      applyOres(777, mockTerrain({ biomeAt: () => biome }), c, c * 3, data);
      for (const cell of cells(data)) found.push(cell);
    }
    return found;
  };

  it('绿宝石仅山地群系生成（平原没有），深板岩宿主放深层变体', () => {
    const plains = oreChunks('plains', 12);
    expect(plains.some((c) => c.id === K('emerald_ore') || c.id === K('deepslate_emerald_ore'))).toBe(false);
    const mt = oreChunks('mountains', 12);
    expect(mt.some((c) => c.id === K('emerald_ore') || c.id === K('deepslate_emerald_ore'))).toBe(true);
    // 深层变体：深板岩宿主中的矿应为 deepslate_* 变体
    const data = new Uint16Array(CHUNK_VOLUME);
    data.fill(K('deepslate'));
    applyOres(777, mockTerrain({ biomeAt: () => 'mountains' }), 1, 1, data);
    const ids = new Set(cells(data).map((c) => c.id));
    expect([...ids].some((id) => BLOCKS[id].key.startsWith('deepslate_') && id !== K('deepslate'))).toBe(true);
  });

  it('恶地金矿加成：恶地 y>24 有金矿，平原金矿限深层', () => {
    const bad = oreChunks('badlands', 12);
    expect(bad.some((c) => c.id === K('gold_ore') && c.y > 24)).toBe(true);
    const plains = oreChunks('plains', 12);
    // 矿脉起点限 y≤16，随机游走可上浮几格（16 + 游走半径 5）
    expect(plains.every((c) => c.id !== K('gold_ore') || c.y <= 21)).toBe(true);
  });

  it('山地有高位铁矿（次峰）与煤矿', () => {
    const mt = oreChunks('mountains', 12);
    expect(mt.some((c) => (c.id === K('iron_ore') || c.id === K('deepslate_iron_ore')) && c.y > 56)).toBe(true);
    expect(mt.some((c) => c.id === K('coal_ore'))).toBe(true);
  });
});

describe('矿石空气暴露削减（discardChanceOnAirExposure）', () => {
  const STONE_ID = K('stone');
  const DEEPSLATE_ID = K('deepslate');

  /** 石头 chunk：在 (x,y,z) 放矿并保证其 +x 邻格是空气（暴露面） */
  const chunkWith = (id: number, x: number, y: number, z: number): Uint16Array => {
    const data = new Uint16Array(CHUNK_VOLUME).fill(STONE_ID);
    data[localIndex(x, y, z)] = id;
    if (x + 1 < 16) data[localIndex(x + 1, y, z)] = AIR;
    return data;
  };

  it('钻石/青金石暴露必回退（丢弃率 1.0），深层变体回退为深板岩', () => {
    const t = mockTerrain({});
    for (const key of ['diamond_ore', 'lapis_ore'] as const) {
      const data = chunkWith(K(key), 4, 30, 4);
      applyAirExposure(777, t, 0, 0, data);
      expect(data[localIndex(4, 30, 4)], key).toBe(STONE_ID);
    }
    const deep = chunkWith(K('deepslate_diamond_ore'), 4, 10, 4);
    applyAirExposure(777, t, 0, 0, deep);
    expect(deep[localIndex(4, 10, 4)]).toBe(DEEPSLATE_ID);
  });

  it('煤/金暴露按 0.5 削减：一批暴露矿部分回退部分保留；铁/红石不受削减', () => {
    const t = mockTerrain({});
    const data = new Uint16Array(CHUNK_VOLUME).fill(STONE_ID);
    // 两列交替摆放煤/金，y 4-27，+z 邻格全挖空制造暴露面
    let n = 0;
    for (let y = 4; y <= 27; y++) {
      for (let x = 0; x < 16; x += 2) {
        data[localIndex(x, y, 4)] = n % 2 === 0 ? K('coal_ore') : K('gold_ore');
        n++;
      }
    }
    for (let y = 3; y <= 28; y++) for (let x = 0; x < 16; x++) data[localIndex(x, y, 5)] = AIR;
    data[localIndex(8, 10, 8)] = K('iron_ore');
    data[localIndex(8, 11, 8)] = K('redstone_ore');
    data[localIndex(8, 10, 9)] = AIR; // 铁矿暴露面
    data[localIndex(8, 11, 9)] = AIR; // 红石暴露面
    applyAirExposure(777, t, 0, 0, data);
    let kept = 0;
    let reverted = 0;
    for (let y = 4; y <= 27; y++) {
      for (let x = 0; x < 16; x += 2) {
        const id = data[localIndex(x, y, 4)];
        if (id === K('coal_ore') || id === K('gold_ore')) kept++;
        else if (id === STONE_ID) reverted++;
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(reverted).toBeGreaterThan(0);
    // Java：铁矿/红石矿无空气暴露削减
    expect(data[localIndex(8, 10, 8)]).toBe(K('iron_ore'));
    expect(data[localIndex(8, 11, 8)]).toBe(K('redstone_ore'));
  });

  it('不暴露的埋藏矿不受影响；邻格是水（非空气）也不算暴露', () => {
    const t = mockTerrain({});
    const data = new Uint16Array(CHUNK_VOLUME).fill(STONE_ID);
    data[localIndex(4, 10, 4)] = K('diamond_ore'); // 六邻全是石头
    data[localIndex(8, 10, 8)] = K('lapis_ore');
    data[localIndex(9, 10, 8)] = K('water'); // 青金石 +x 邻格灌水（水下洞腔不算暴露）
    applyAirExposure(777, t, 0, 0, data);
    expect(data[localIndex(4, 10, 4)]).toBe(K('diamond_ore'));
    expect(data[localIndex(8, 10, 8)]).toBe(K('lapis_ore'));
  });

  it('chunk 边界矿格：跨界邻格按地形推断（邻列被雕空即视为暴露），不读邻 chunk', () => {
    // 矿在 x=15 边界，邻 chunk 的 (16,y,z) 被洞穴雕空（陆地不灌水）→ 钻石回退
    const carved = mockTerrain({ caveAt: (x, y) => x >= 16 && y >= 4 && y <= 45 });
    const data = new Uint16Array(CHUNK_VOLUME).fill(STONE_ID);
    data[localIndex(15, 30, 8)] = K('diamond_ore');
    applyAirExposure(777, carved, 0, 0, data);
    expect(data[localIndex(15, 30, 8)]).toBe(STONE_ID);
    // 对照：邻列是海床下洞腔（灌水）→ 不算暴露，钻石保留
    const flooded = mockTerrain({ heightAt: () => 18, caveAt: (x, y) => x >= 16 && y >= 4 && y <= 18 });
    const data2 = new Uint16Array(CHUNK_VOLUME).fill(STONE_ID);
    data2[localIndex(15, 10, 8)] = K('diamond_ore');
    applyAirExposure(777, flooded, 0, 0, data2);
    expect(data2[localIndex(15, 10, 8)]).toBe(K('diamond_ore'));
  });
});

describe('标志植被生成', () => {
  it('沙漠：仙人掌生成且四邻无实心，枯灌木存在', () => {
    const w = new World('veg-desert', undefined, mockTerrain({ biomeAt: () => 'desert' }));
    let cactus = 0;
    let bush = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        const data = w.getChunk(cx, cz).data;
        for (const { x, y, z, id } of cells(data)) {
          if (id === K('cactus')) {
            cactus++;
            // 该仙人掌段的四邻（同 chunk 内）不得为实心方块（空气/仙人掌/花草等非实心均可，MC 规则）
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = x + dx;
              const nz = z + dz;
              if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
              const nb = data[localIndex(nx, y, nz)];
              expect(BLOCKS[nb]?.solid !== true || nb === K('cactus')).toBe(true);
            }
          }
          if (id === K('dead_bush')) bush++;
        }
      }
    }
    expect(cactus).toBeGreaterThan(0);
    expect(bush).toBeGreaterThan(0);
  });

  it('甘蔗只长在水边（四邻同高有水）', () => {
    // 半侧水潭（h=39 低于海平面蓄水）半侧岸（h=40）：岸列才可能出甘蔗
    const t = mockTerrain({
      heightAt: (x) => ((x & 15) < 8 ? SEA_LEVEL - 1 : SEA_LEVEL),
      biomeAt: () => 'plains',
    });
    const w = new World('veg-cane', undefined, t);
    let cane = 0;
    for (let cx = 0; cx < 4; cx++) {
      for (let cz = 0; cz < 4; cz++) {
        const data = w.getChunk(cx, cz).data;
        for (const { x, y, z, id } of cells(data)) {
          if (id !== K('sugar_cane')) continue;
          // 只对底段（下方非甘蔗）断言：岸的四邻同层必有水
          if (y > 0 && data[localIndex(x, y - 1, z)] === K('sugar_cane')) continue;
          cane++;
          // 邻格可能在相邻 chunk（边界列现在也允许长甘蔗），按世界坐标跨 chunk 读
          const wx = cx * 16 + x;
          const wz = cz * 16 + z;
          const below = y - 1;
          const near =
            w.getBlock(wx + 1, below, wz) === BLOCK_BY_KEY.water.id ||
            w.getBlock(wx - 1, below, wz) === BLOCK_BY_KEY.water.id ||
            w.getBlock(wx, below, wz + 1) === BLOCK_BY_KEY.water.id ||
            w.getBlock(wx, below, wz - 1) === BLOCK_BY_KEY.water.id;
          expect(near).toBe(true);
        }
      }
    }
    expect(cane).toBeGreaterThan(0);
  });

  it('蘑菇岛：巨蘑菇（菌柄 + 伞盖）与小蘑菇生成', () => {
    const w = new World('veg-mush', undefined, mockTerrain({ biomeAt: () => 'mushroom_fields' }));
    let stem = 0;
    let cap = 0;
    let small = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        for (const { id } of cells(w.getChunk(cx, cz).data)) {
          if (id === K('mushroom_stem')) stem++;
          if (id === K('red_mushroom_block') || id === K('brown_mushroom_block')) cap++;
          if (id === K('red_mushroom') || id === K('brown_mushroom')) small++;
        }
      }
    }
    expect(stem).toBeGreaterThan(0);
    expect(cap).toBeGreaterThan(0);
    expect(small).toBeGreaterThan(0);
  });

  it('沼泽水面有睡莲', () => {
    // 全水潭：h 低于海平面，沼泽群系 → 水面 (SEA_LEVEL+1) 出睡莲
    const t = mockTerrain({
      heightAt: () => SEA_LEVEL - 2,
      biomeAt: () => 'swamp',
    });
    const w = new World('veg-lily', undefined, t);
    let lily = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        for (const { id } of cells(w.getChunk(cx, cz).data)) {
          if (id === K('lily_pad')) lily++;
        }
      }
    }
    expect(lily).toBeGreaterThan(0);
  });

  it('Java 群系归属：丛林水面无睡莲（睡莲仅沼泽）', () => {
    const t = mockTerrain({
      heightAt: () => SEA_LEVEL - 2,
      biomeAt: () => 'jungle',
    });
    const w = new World('veg-lily-jungle', undefined, t);
    let lily = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        for (const { id } of cells(w.getChunk(cx, cz).data)) {
          if (id === K('lily_pad')) lily++;
        }
      }
    }
    expect(lily).toBe(0);
  });

  it('Java 群系归属：森林无蓝兰花（蓝兰花仅沼泽），普通针叶林不铺雪层', () => {
    const forest = new World('veg-forest', undefined, mockTerrain({ biomeAt: () => 'forest' }));
    let orchid = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        for (const { id } of cells(forest.getChunk(cx, cz).data)) {
          if (id === K('blue_orchid')) orchid++;
        }
      }
    }
    expect(orchid).toBe(0);
    // 普通针叶林无雪盖（雪层属于积雪针叶林群系，本项目无此群系则直接移除）
    const taiga = new World('veg-taiga', undefined, mockTerrain({ biomeAt: () => 'taiga' }));
    let snow = 0;
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 6; cz++) {
        for (const { id } of cells(taiga.getChunk(cx, cz).data)) {
          if (id === K('snow_layer')) snow++;
        }
      }
    }
    expect(snow).toBe(0);
  });
});

describe('恶地陶瓦地层', () => {
  it('台地柱内出现彩色陶瓦带', () => {
    const w = new World('bad-bands', undefined, mockTerrain({ heightAt: () => 70, biomeAt: () => 'badlands' }));
    const c = w.getChunk(0, 0);
    const terra = new Set<string>();
    for (let y = 70 - 32; y < 70 - 3; y++) {
      const key = BLOCKS[c.data[localIndex(8, y, 8)]]?.key;
      if (key?.endsWith('terracotta')) terra.add(key);
    }
    expect(terra.size).toBeGreaterThan(1); // 多层多色
  });
});

describe('树形库（与树苗生长共用）', () => {
  const record = (kind: Parameters<typeof writeTree>[1]) => {
    const placed = new Map<string, number>();
    const put = (x: number, y: number, z: number, id: number, onlyAir: boolean) => {
      if (onlyAir && placed.has(`${x},${y},${z}`)) return; // 与真实 put 一致：树叶不覆盖已有方块
      placed.set(`${x},${y},${z}`, id);
    };
    writeTree(put, kind, 0, 0, 0, () => 0.5);
    const cells = [...placed.entries()].map(([k, id]) => ({ pos: k.split(',').map(Number), id }));
    const logs = cells.filter((c) => BLOCKS[c.id].key.includes('log'));
    const leaves = cells.filter((c) => BLOCKS[c.id].key.includes('leaves'));
    return { logs, leaves };
  };

  it('橡木 4-6 干 blob 冠 / 白桦 5-7 干 / 云杉锥形高干 / 丛林 10+ 高干', () => {
    // rand 恒 0.5：橡树干 H=4+⌊0.5×3⌋=5，白桦 H=5+⌊0.5×3⌋=6（Java 区间 4-6 / 5-7 内）
    expect(record('oak').logs.length).toBe(5);
    expect(record('birch').logs.length).toBe(6);
    expect(record('spruce').logs.length).toBeGreaterThanOrEqual(7);
    expect(record('jungle').logs.length).toBeGreaterThanOrEqual(10);
    expect(record('oak').leaves.length).toBeGreaterThan(10);
  });

  it('深色橡木 2×2 粗干 / 金合欢 5 段斜干 / 樱花有粉冠', () => {
    const dark = record('dark_oak');
    expect(dark.logs.length % 4).toBe(0); // 每层 4 根
    expect(dark.logs.length).toBeGreaterThanOrEqual(24);
    expect(record('acacia').logs.length).toBe(5);
    const cherry = record('cherry');
    expect(cherry.leaves.every((c) => BLOCKS[c.id].key === 'cherry_leaves')).toBe(true);
    expect(cherry.leaves.length).toBeGreaterThan(15);
  });

  it('世界生成的树：所有树叶 distance ≤6（distance 凋零模型不误杀正常树冠）', () => {
    const kinds: TreeKind[] = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'cherry'];
    for (const kind of kinds) {
      const w = new World(`gen-dist-${kind}`, undefined, mockTerrain({
        treeAt: (x, z) => (x % 8 === 4 && z % 8 === 4 ? kind : null),
      }));
      // 预载 3×3 chunk：BFS 不跨未加载 chunk（金合欢斜干+冠可外溢到相邻 chunk）
      for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 3; cz++) w.getChunk(cx, cz);
      let leaves = 0;
      for (let cx = 0; cx < 2; cx++) {
        for (let cz = 0; cz < 2; cz++) {
          const data = w.getChunk(cx, cz).data;
          for (let i = 0; i < data.length; i++) {
            if (!isLeavesId(data[i])) continue;
            // localIndex 反解：i = (y*16 + z)*16 + x
            const d = leafDistanceToLog(w, cx * 16 + (i & 15), i >> 8, cz * 16 + ((i >> 4) & 15));
            expect(d).toBeLessThanOrEqual(6);
            leaves++;
          }
        }
      }
      expect(leaves).toBeGreaterThan(0);
    }
  });
});

describe('存档版本', () => {
  it('SAVE_VERSION=8（容器/熔炉/酿造按维度隔离存储，旧档经 migration 链迁移而非直接清库）', () => {
    expect(SAVE_VERSION).toBe(8);
  });
});
