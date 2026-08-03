import { describe, expect, it } from 'vitest';
import { BLOCKS, STONE, WATER, GLASS, LEAVES, WATER_FLOW_1, BLOCK_BY_KEY } from '../blocks';
import { buildChunkGeometry, buildFromGrid, chunkBiomes, type GeometryData } from '../mesher';
import { createTerrain, VOID_TERRAIN, type Terrain } from '../noise';
import { CHUNK_SIZE, CHUNK_VOLUME, localIndex, WORLD_HEIGHT, World } from '../world';
import { flushLight } from '../lights';

function voidWorld(): World {
  return new World('test', undefined, VOID_TERRAIN);
}

describe('mesher 面剔除', () => {
  it('孤立方块生成 6 个面', () => {
    const w = voidWorld();
    w.setBlock(8, 8, 8, STONE);
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    expect(g.solid.indices.length).toBe(6 * 6);
    expect(g.solid.positions.length).toBe(24 * 3);
    expect(g.water.indices.length).toBe(0);
  });

  it('相邻同类方块之间的面被剔除，共面同色的面合并为一个四边形', () => {
    const w = voidWorld();
    w.setBlock(8, 8, 8, STONE);
    w.setBlock(9, 8, 8, STONE);
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    // 12 面 - 2 共享面 = 10 面；其中 4 对共面平行面各合并为 1（顶/底/±z），两端 ±x 面不变 → 6 个四边形
    expect(g.solid.indices.length).toBe(6 * 6);
  });

  it('满 chunk 只渲染外表面，且每个外表面合并为单个四边形', () => {
    const w = voidWorld();
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          w.setBlock(x, y, z, STONE);
        }
      }
    }
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    // 旧逐面：4×16×128 + 2×16×16 面；合并后每个边界平面（同色同 tile）1 个四边形 → 6 面
    expect(g.solid.indices.length).toBe(6 * 6);
  });

  it('水走透明几何，水-水相邻面剔除，共面水面合并', () => {
    const w = voidWorld();
    w.setBlock(4, 4, 4, WATER);
    w.setBlock(5, 4, 4, WATER);
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    expect(g.solid.indices.length).toBe(0);
    // 10 面中 4 对共面面各合并为 1 → 6 个四边形
    expect(g.water.indices.length).toBe(6 * 6);
  });

  it('相邻玻璃之间不画内部面，共面玻璃面合并', () => {
    const w = voidWorld();
    w.setBlock(4, 4, 4, GLASS);
    w.setBlock(4, 4, 5, GLASS);
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    // 10 面中 4 对共面面各合并为 1 → 6 个四边形
    expect(g.solid.indices.length).toBe(6 * 6);
  });

  it('未知方块 id 按空气处理，不抛错', () => {
    const w = voidWorld();
    w.setBlock(4, 4, 4, BLOCKS.length + 100); // 超出注册表的 id（如旧版本存档残留）
    w.setBlock(5, 4, 4, STONE);
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    expect(g.solid.indices.length).toBe(6 * 6); // 只剩石头方块的 6 面
  });

  it('AO：孤立方块顶面全亮（侧面按 MC 方向明暗），有相邻遮挡时顶点变暗', () => {
    const w1 = voidWorld();
    w1.setBlock(8, 8, 8, STONE);
    const g1 = buildChunkGeometry(w1, w1.getChunk(0, 0));
    expect(g1.solid.colors.length).toBe(g1.solid.positions.length); // 每顶点一个 RGB
    expect(Math.max(...g1.solid.colors)).toBe(1); // 顶面全亮（MC 方向明暗：顶 1.0）
    expect(Math.min(...g1.solid.colors)).toBe(0.5); // 底面 0.5

    const w2 = voidWorld();
    w2.setBlock(8, 8, 8, STONE);
    w2.setBlock(9, 9, 8, STONE); // 挡住 +x 面上角的侧边，产生遮蔽
    const g2 = buildChunkGeometry(w2, w2.getChunk(0, 0));
    expect(Math.min(...g2.solid.colors)).toBeLessThan(1);
  });

  it('水面高度 0.875，水柱内部顶面被剔除', () => {
    const w1 = voidWorld();
    w1.setBlock(4, 4, 4, WATER);
    const g1 = buildChunkGeometry(w1, w1.getChunk(0, 0));
    const ys1 = [...g1.water.positions].filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys1)).toBeCloseTo(4.875);

    const w2 = voidWorld();
    w2.setBlock(4, 4, 4, WATER);
    w2.setBlock(4, 5, 4, WATER);
    const g2 = buildChunkGeometry(w2, w2.getChunk(0, 0));
    const ys2 = [...g2.water.positions].filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys2)).toBeCloseTo(5.875); // 只有上层水的顶面，且同样下沉
    expect(ys2.some((y) => y > 5.875)).toBe(false);
  });
});

describe('mesher 贪心合并', () => {
  it('同色同 tile 的平面合并、AO 差异阻止合并，且逐顶点携带 tile 基址', () => {
    // 4×4 平台：顶面在均匀光照下四角颜色一致 → 合并为 1 个四边形
    const w = voidWorld();
    for (let x = 4; x < 8; x++) {
      for (let z = 4; z < 8; z++) w.setBlock(x, 8, z, STONE);
    }
    const g = buildChunkGeometry(w, w.getChunk(0, 0));
    // 顶 1 + 底 1 + 4 侧条 = 6 个四边形
    expect(g.solid.indices.length).toBe(6 * 6);
    // 块单位 UV 新约定：逐顶点 tile 基址（石头各面 tile）
    expect(g.solid.tiles).toBeDefined();
    expect(g.solid.tiles!.length).toBe(g.solid.positions.length / 3);
    // 顶面合并矩形 UV 跨 4 格（块单位 0..4）
    expect(Math.max(...g.solid.uvs)).toBe(4);

    // 在平台一角上方压一块石头：其正下方顶面顶点 AO 变暗 → 顶面不再整片合并
    const w2 = voidWorld();
    for (let x = 4; x < 8; x++) {
      for (let z = 4; z < 8; z++) w2.setBlock(x, 8, z, STONE);
    }
    w2.setBlock(4, 9, 4, STONE);
    const g2 = buildChunkGeometry(w2, w2.getChunk(0, 0));
    // 顶面拆成多个四边形（被压格及其相邻受影响列不再同色）
    const topQuads = countTopQuads(g2);
    expect(topQuads).toBeGreaterThan(1);
    // 展开后总面数守恒：合并不丢面（4×4 顶面 = 16 单位面）
    expect(expandTopFaces(g2)).toBe(16);
  });
});

/** 顶面（法线 +Y）四边形数 */
function countTopQuads(g: { solid: GeometryData }): number {
  let n = 0;
  for (let i = 0; i < g.solid.normals.length; i += 3) {
    if (g.solid.normals[i + 1] === 1) n++;
  }
  return n / 4;
}

/** 顶面合并矩形展开为单位面总数（按 UV 跨度 w×h） */
function expandTopFaces(g: { solid: GeometryData }): number {
  let total = 0;
  for (let q = 0; q < g.solid.indices.length / 6; q++) {
    const v0 = g.solid.indices[q * 6];
    if (g.solid.normals[v0 * 3 + 1] !== 1) continue;
    let w = 0;
    let h = 0;
    for (let k = 0; k < 4; k++) {
      w = Math.max(w, g.solid.uvs[(v0 + k) * 2]);
      h = Math.max(h, g.solid.uvs[(v0 + k) * 2 + 1]);
    }
    total += w * h;
  }
  return total;
}

describe('chunkBiomes 群系列缓存', () => {
  it('缓存只缓存查询结果：重复/重叠列不重复求值，结果与直算一致', () => {
    // 包一层计数 terrain，统计 biomeAt 实际求值次数
    const base = createTerrain('biome-cache');
    let calls = 0;
    const counting: Terrain = {
      ...base,
      biomeAt: (x, z) => {
        calls++;
        return base.biomeAt(x, z);
      },
    };
    const w = new World('biome-cache', undefined, counting);
    // 未走缓存的参照：同一真实地形直接逐列求值
    const ref = new World('biome-cache');
    const refBiomes = chunkBiomes(ref, 3, -2);

    const a = chunkBiomes(w, 3, -2);
    expect(calls).toBe(18 * 18); // 首次 324 列全算
    const b = chunkBiomes(w, 3, -2);
    expect(calls).toBe(18 * 18); // 第二次全命中缓存，零新增求值
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // 与未缓存路径结果一致（缓存不改群系判定）
    expect(Buffer.from(a).equals(Buffer.from(refBiomes))).toBe(true);
    // 相邻 chunk：环带重叠 2×18 列命中缓存，只有 16×18 新列求值
    chunkBiomes(w, 4, -2);
    expect(calls).toBe(18 * 18 + 16 * 18);
  });

  it('同种子不同世界实例群系数组一致（缓存按地形实例隔离）', () => {
    const a = chunkBiomes(new World('same-seed'), 1, 1);
    const b = chunkBiomes(new World('same-seed'), 1, 1);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

// ——— 贪心合并等价性：合并矩形展开为单位面后，与非合并（greedy=false）输出按
// 位置/朝向/tile/四角颜色 构成多重集合完全一致 ———

/** 单位面多重集合 key：dir | 最小角点 | tile | 四角颜色（按角点位置排序） */
function unitFaceKey(nx: number, ny: number, nz: number, tile: number, corners: { p: [number, number, number]; c: [number, number, number] }[]): string {
  const minx = Math.min(...corners.map((c) => c.p[0]));
  const miny = Math.min(...corners.map((c) => c.p[1]));
  const minz = Math.min(...corners.map((c) => c.p[2]));
  const cs = corners
    .map((c) => ({ k: `${c.p[0]},${c.p[1]},${c.p[2]}`, c: c.c }))
    .sort((a, b) => (a.k < b.k ? -1 : 1))
    .map((x) => x.c.join(','))
    .join('|');
  return `${nx},${ny},${nz}|${minx},${miny},${minz}|${tile}|${cs}`;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 几何（可含合并矩形）展开为单位面 multiset；water=true 时 tile 记为水（-2） */
function expandToUnitFaces(g: GeometryData, water: boolean): Map<string, number> {
  const map = new Map<string, number>();
  for (let q = 0; q < g.indices.length / 6; q++) {
    const v0 = g.indices[q * 6];
    const nx = g.normals[v0 * 3];
    const ny = g.normals[v0 * 3 + 1];
    const nz = g.normals[v0 * 3 + 2];
    const tile = water ? -2 : g.tiles![v0];
    let w = 0;
    let h = 0;
    const at = new Map<string, { p: [number, number, number]; c: [number, number, number] }>();
    for (let k = 0; k < 4; k++) {
      const v = v0 + k;
      const u = g.uvs[v * 2];
      const vv = g.uvs[v * 2 + 1];
      w = Math.max(w, u);
      h = Math.max(h, vv);
      at.set(`${u},${vv}`, {
        p: [g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]],
        c: [g.colors[v * 3], g.colors[v * 3 + 1], g.colors[v * 3 + 2]],
      });
    }
    const K00 = at.get('0,0')!;
    const K10 = at.get(`${w},0`)!;
    const K01 = at.get(`0,${h}`)!;
    const K11 = at.get(`${w},${h}`)!;
    const eqC = (a: { c: number[] }, b: { c: number[] }): boolean => a.c[0] === b.c[0] && a.c[1] === b.c[1] && a.c[2] === b.c[2];
    const uIndep = eqC(K00, K10) && eqC(K01, K11);
    const vIndep = eqC(K00, K01) && eqC(K10, K11);
    // 合并合法性自证：沿合并方向颜色必须定常（否则展开无意义）
    expect(w > 1 ? uIndep : true).toBe(true);
    expect(h > 1 ? vIndep : true).toBe(true);
    const rp = K00.p;
    const uVec: [number, number, number] = [(K10.p[0] - rp[0]) / w, (K10.p[1] - rp[1]) / w, (K10.p[2] - rp[2]) / w];
    const vVec: [number, number, number] = [(K01.p[0] - rp[0]) / h, (K01.p[1] - rp[1]) / h, (K01.p[2] - rp[2]) / h];
    const pick = (cu: number, cv: number): [number, number, number] =>
      uIndep ? (cv ? K01 : K00).c : vIndep ? (cu ? K10 : K00).c : cu ? (cv ? K11 : K10).c : cv ? K01.c : K00.c;
    for (let du = 0; du < w; du++) {
      for (let dv = 0; dv < h; dv++) {
        const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as const).map(([cu, cv]) => ({
          p: [
            rp[0] + uVec[0] * (du + cu) + vVec[0] * (dv + cv),
            rp[1] + uVec[1] * (du + cu) + vVec[1] * (dv + cv),
            rp[2] + uVec[2] * (du + cu) + vVec[2] * (dv + cv),
          ] as [number, number, number],
          c: pick(cu, cv),
        }));
        bump(map, unitFaceKey(nx, ny, nz, tile, corners));
      }
    }
  }
  return map;
}

function gridOf(w: World, cx: number, cz: number): { datas: (Uint16Array | null)[]; lights: (Uint8Array | null)[]; skys: (Uint8Array | null)[] } {
  const datas: (Uint16Array | null)[] = [];
  const lights: (Uint8Array | null)[] = [];
  const skys: (Uint8Array | null)[] = [];
  for (let gz = -1; gz <= 1; gz++) {
    for (let gx = -1; gx <= 1; gx++) {
      const c = w.chunks.get(`${cx + gx},${cz + gz}`);
      datas.push(c?.data ?? null);
      lights.push(c?.light ?? null);
      skys.push(c?.sky ?? null);
    }
  }
  return { datas, lights, skys };
}

describe('贪心合并等价性', () => {
  it('合成 chunk：合并展开与非合并输出多重集合一致', () => {
    const w = new World('greedy-equiv', undefined, VOID_TERRAIN);
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) w.getChunk(cx, cz);
    }
    // 平台（均匀合并）+ 凸起（AO 破合并）+ 光源（光照梯度）+ 玻璃盒/树叶（同 id 剔除）+ 水面落差 + 形状块
    for (let x = 2; x < 14; x++) {
      for (let z = 2; z < 14; z++) w.setBlock(x, 40, z, STONE);
    }
    w.setBlock(5, 41, 5, STONE);
    w.setBlock(6, 41, 6, BLOCK_BY_KEY.glowstone.id);
    for (let x = 20; x < 24; x++) {
      for (let y = 40; y < 44; y++) {
        for (let z = 20; z < 24; z++) {
          if (x === 20 || x === 23 || y === 40 || y === 43 || z === 20 || z === 23) w.setBlock(x, y, z, GLASS);
        }
      }
    }
    for (let x = 26; x < 29; x++) {
      for (let y = 40; y < 43; y++) {
        for (let z = 20; z < 23; z++) w.setBlock(x, y, z, LEAVES);
      }
    }
    w.setBlock(4, 44, 30, WATER);
    w.setBlock(5, 44, 30, WATER_FLOW_1);
    w.setBlock(6, 44, 30, WATER_FLOW_1 + 2);
    w.setBlock(4, 43, 30, WATER);
    w.setBlock(10, 41, 10, BLOCK_BY_KEY.planks_stairs_w.id);
    w.setBlock(11, 41, 10, BLOCK_BY_KEY.stone_slab.id);
    w.setBlock(12, 41, 10, BLOCK_BY_KEY.oak_fence.id);
    flushLight(w);
    const { datas, lights, skys } = gridOf(w, 0, 0);
    const merged = buildFromGrid(0, 0, datas, lights, skys, null, true);
    const plain = buildFromGrid(0, 0, datas, lights, skys, null, false);
    // 合并确实生效（否则本测试无意义）
    expect(merged.solid.indices.length).toBeLessThan(plain.solid.indices.length);
    expect(expandToUnitFaces(merged.solid, false)).toEqual(expandToUnitFaces(plain.solid, false));
    expect(expandToUnitFaces(merged.water, true)).toEqual(expandToUnitFaces(plain.water, true));
  });

  it('真实地形 chunk（含群系 tint/光照/水）：合并展开与非合并输出一致', () => {
    const w = new World('greedy-equiv-real');
    for (let cx = -2; cx <= 2; cx++) {
      for (let cz = -2; cz <= 2; cz++) w.getChunk(cx, cz);
    }
    flushLight(w);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1]] as const) {
      const { datas, lights, skys } = gridOf(w, cx, cz);
      const biomes = chunkBiomes(w, cx, cz);
      const merged = buildFromGrid(cx, cz, datas, lights, skys, biomes, true);
      const plain = buildFromGrid(cx, cz, datas, lights, skys, biomes, false);
      expect(merged.solid.indices.length).toBeLessThan(plain.solid.indices.length);
      expect(expandToUnitFaces(merged.solid, false)).toEqual(expandToUnitFaces(plain.solid, false));
      expect(expandToUnitFaces(merged.water, true)).toEqual(expandToUnitFaces(plain.water, true));
    }
  });

  it('随机方块 soup：合并展开与非合并输出一致', () => {
    const w = new World('greedy-equiv-random', undefined, VOID_TERRAIN);
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) w.getChunk(cx, cz);
    }
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ids = [STONE, GLASS, LEAVES, WATER, BLOCK_BY_KEY.glowstone.id, BLOCK_BY_KEY.dirt.id, BLOCK_BY_KEY.sand.id];
    const data = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < 1400; i++) {
      const x = Math.floor(rnd() * CHUNK_SIZE);
      const y = 30 + Math.floor(rnd() * 40);
      const z = Math.floor(rnd() * CHUNK_SIZE);
      data[localIndex(x, y, z)] = ids[Math.floor(rnd() * ids.length)];
    }
    w.chunks.get('0,0')!.data.set(data);
    flushLight(w);
    const { datas, lights, skys } = gridOf(w, 0, 0);
    const merged = buildFromGrid(0, 0, datas, lights, skys, null, true);
    const plain = buildFromGrid(0, 0, datas, lights, skys, null, false);
    expect(expandToUnitFaces(merged.solid, false)).toEqual(expandToUnitFaces(plain.solid, false));
    expect(expandToUnitFaces(merged.water, true)).toEqual(expandToUnitFaces(plain.water, true));
  });
});
