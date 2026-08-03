// 地形生成 worker 化：纯管线（genCore）与同步 getChunk 的逐格一致性 + World 双路径行为

import { describe, expect, it } from 'vitest';
import { World, CHUNK_VOLUME, chunkKey, type GenApply } from '../world';
import { generateChunkData } from '../genCore';
import { createNetherTerrain } from '../nether';
import { createEndTerrain } from '../end';
import { clearStorages, storages } from '../storage';

/** 采样 chunk 坐标：原点/正负/跨区域边界（REGION=64 格=4 chunk）/远点 */
const SAMPLE_CHUNKS: [number, number][] = [
  [0, 0], [1, 0], [0, 1], [-1, -1], [3, -2], [4, 4], [-4, 3], [7, 7],
  [-5, -6], [8, -1], [16, 16], [-16, -8], [31, 7], [100, -100], [-57, 42],
];

describe('generateChunkData 与同步 getChunk 逐格一致', () => {
  it('主世界：多种子多坐标产物完全相同', () => {
    for (const seed of ['gen-seed', '123', '另一个种子']) {
      const w = new World(seed);
      for (const [cx, cz] of SAMPLE_CHUNKS) {
        const sync = w.getChunk(cx, cz).data;
        const asyncData = new Uint16Array(CHUNK_VOLUME);
        generateChunkData(seed, 'overworld', cx, cz, asyncData);
        expect(asyncData, `${seed} @ ${cx},${cz}`).toEqual(sync);
      }
    }
  });

  it('下界/末地：维度管线产物完全相同', () => {
    for (const base of ['dim-seed', '42']) {
      const nseed = `${base}:nether`;
      const eseed = `${base}:end`;
      const nw = new World(nseed, undefined, createNetherTerrain(nseed));
      const ew = new World(eseed, undefined, createEndTerrain(eseed));
      for (const [cx, cz] of SAMPLE_CHUNKS.slice(0, 8)) {
        const nd = new Uint16Array(CHUNK_VOLUME);
        generateChunkData(nseed, 'nether', cx, cz, nd);
        expect(nd, `nether @ ${cx},${cz}`).toEqual(nw.getChunk(cx, cz).data);
        const ed = new Uint16Array(CHUNK_VOLUME);
        generateChunkData(eseed, 'end', cx, cz, ed);
        expect(ed, `end @ ${cx},${cz}`).toEqual(ew.getChunk(cx, cz).data);
      }
    }
  });

  it('结构战利品：worker 回传并回后与同步生成的 storages 完全一致', () => {
    const seed = 'loot-seed';
    const range: [number, number][] = [];
    for (let cx = -4; cx <= 4; cx++) for (let cz = -4; cz <= 4; cz++) range.push([cx, cz]);
    // 同步路径：生成期 fillChest 直接写全局 storages
    clearStorages();
    const w = new World(seed);
    for (const [cx, cz] of range) w.getChunk(cx, cz);
    const syncLoot = new Map([...storages].filter(([, s]) => s.some((x) => x !== null)));
    expect(syncLoot.size).toBeGreaterThan(0); // 9×9 chunk 内必有结构宝箱，否则本断言无效
    // worker 路径：逐 chunk 捕获 chests 并按 fillChest 幂等语义并回
    clearStorages();
    for (const [cx, cz] of range) {
      const chests = generateChunkData(seed, 'overworld', cx, cz, new Uint16Array(CHUNK_VOLUME));
      for (const [pos, slots] of chests) {
        const st = storages.get(pos) ?? [];
        if (st.some((s) => s !== null)) continue;
        storages.set(pos, [...slots]);
      }
    }
    const asyncLoot = new Map([...storages].filter(([, s]) => s.some((x) => x !== null)));
    expect([...asyncLoot.keys()].sort()).toEqual([...syncLoot.keys()].sort());
    for (const [k, v] of asyncLoot) expect(v, `loot @ ${k}`).toEqual(syncLoot.get(k));
    clearStorages();
  });

  it('generateChunkData 不残留 storages 全局状态（自带清理）', () => {
    clearStorages();
    generateChunkData('gen-seed', 'overworld', 0, 0, new Uint16Array(CHUNK_VOLUME));
    expect(storages.size).toBe(0);
  });
});

/** 收集注入式 dispatcher 的 apply 回调，模拟 worker 完成时逐个落地 */
function collectDispatch(w: World) {
  const inflight = new Map<string, GenApply>();
  w.genDispatch = (cx, cz, apply) => {
    inflight.set(chunkKey(cx, cz), apply);
    return true;
  };
  return inflight;
}

/** 用与 worker 相同的管线产出并落地 */
function landAll(w: World, inflight: Map<string, GenApply>, seed: string) {
  for (const [key, apply] of [...inflight]) {
    inflight.delete(key);
    const [cx, cz] = key.split(',').map(Number);
    const data = new Uint16Array(CHUNK_VOLUME);
    const chests = generateChunkData(seed, w.terrain.kind ?? 'overworld', cx, cz, data);
    apply(data, chests);
  }
}

describe('updateAround 双路径（worker 异步热路径 + 同步兜底）', () => {
  it('无存档缺失走异步派发：主线程不生成，落地后与同步世界逐格一致', () => {
    const seed = 'dual-path';
    const w = new World(seed);
    const inflight = collectDispatch(w);
    const remaining = w.updateAround(0, 0, 2, 10_000);
    expect(w.chunks.size).toBe(0); // 主线程零生成
    expect(inflight.size).toBe(25);
    expect(w.pendingGen.size).toBe(25);
    expect(remaining).toBe(25); // 在途也算缺失（初始加载判定不提前完成）
    // 同位置重扫不重复派发
    expect(w.updateAround(0, 0, 2, 10_000)).toBe(25);
    expect(inflight.size).toBe(25);
    // 落地
    landAll(w, inflight, seed);
    expect(w.pendingGen.size).toBe(0);
    expect(w.chunks.size).toBe(25);
    // 与纯同步世界逐格一致
    const ref = new World(seed);
    ref.updateAround(0, 0, 2, 10_000);
    for (const [key, c] of w.chunks) {
      expect(c.data, key).toEqual(ref.chunks.get(key)!.data);
      expect(c.lightDirty).toBe(true); // 光照标脏走 flushLight 摊销，未回同步 cascadeLight
      expect(w.dirtyChunks.has(key)).toBe(true); // 走既有 dirtyChunks→mesherPool 流程
    }
    // 铺满后返回 0 且记忆化早退生效
    expect(w.updateAround(0, 0, 2, 10_000)).toBe(0);
    expect(w.updateAround(0, 0, 2, 10_000)).toBe(0);
  });

  it('有存档的 chunk 不派 worker：同步读档优先', () => {
    const seed = 'saved-first';
    const ref = new World(seed);
    const savedData = new Uint16Array(ref.getChunk(0, 0).data);
    const saved = new Map([[chunkKey(0, 0), savedData]]);
    const w = new World(seed, saved);
    const inflight = collectDispatch(w);
    w.updateAround(0, 0, 1, 10_000);
    expect(inflight.has(chunkKey(0, 0))).toBe(false); // 有存档不派发
    expect(w.chunks.get(chunkKey(0, 0))!.data).toEqual(savedData); // 同步读档落地
    expect(inflight.size).toBe(8); // 其余 8 个无存档的走异步
  });

  it('在途期间存档到达：落地时存档优先，worker 产物丢弃', () => {
    const seed = 'saved-race';
    const w = new World(seed);
    const inflight = collectDispatch(w);
    w.updateAround(0, 0, 0, 10_000);
    expect(inflight.size).toBe(1);
    const ref = new World(seed);
    const savedData = new Uint16Array(ref.getChunk(0, 0).data);
    savedData[0] = savedData[0] ^ 1; // 人为区别于生成产物
    w.applySavedChunk(chunkKey(0, 0), savedData);
    landAll(w, inflight, seed);
    expect(w.chunks.get(chunkKey(0, 0))!.data).toEqual(savedData);
  });

  it('同步兜底（getBlock/getChunk）取消在途请求，迟到结果被丢弃', () => {
    const seed = 'fallback';
    const w = new World(seed);
    const inflight = collectDispatch(w);
    w.updateAround(0, 0, 1, 10_000);
    expect(inflight.size).toBe(9);
    // 隐式同步生成（传送/边缘访问路径）
    w.getBlock(8, 64, 8); // chunk (0,0)
    expect(w.pendingGen.has(chunkKey(0, 0))).toBe(false);
    const syncData = w.chunks.get(chunkKey(0, 0))!.data;
    // worker 迟到结果被丢弃（chunk 已存在，不被覆盖）
    const apply = inflight.get(chunkKey(0, 0))!;
    const junk = new Uint16Array(CHUNK_VOLUME).fill(1);
    apply(junk, []);
    expect(w.chunks.get(chunkKey(0, 0))!.data).toEqual(syncData);
  });

  it('卸载半径外的在途请求被取消', () => {
    const w = new World('cancel-far');
    collectDispatch(w);
    w.updateAround(0, 0, 2, 10_000);
    expect(w.pendingGen.size).toBe(25);
    // 玩家瞬移到远处：半径+2 外的在途全部取消
    w.updateAround(100 * 16, 0, 2, 10_000);
    expect(w.pendingGen.size).toBe(25); // 只剩新中心周围的在途
    expect([...w.pendingGen].every((k) => {
      const [cx] = k.split(',').map(Number);
      return Math.abs(cx - 100) <= 4;
    })).toBe(true);
  });

  it('战利品经 apply 并回 storages（与同步生成一致）', () => {
    clearStorages();
    const w = new World('loot-seed');
    const inflight = collectDispatch(w);
    w.updateAround(0, 0, 4, 10_000); // 9×9 chunk，覆盖必有结构宝箱的区域（见上方 loot 一致性测试）
    landAll(w, inflight, 'loot-seed');
    const viaApply = new Map([...storages].filter(([, s]) => s.some((x) => x !== null)));
    clearStorages();
    const ref = new World('loot-seed');
    ref.updateAround(0, 0, 4, 10_000);
    const viaSync = new Map([...storages].filter(([, s]) => s.some((x) => x !== null)));
    expect(viaApply.size).toBeGreaterThan(0);
    expect([...viaApply.keys()].sort()).toEqual([...viaSync.keys()].sort());
    for (const [k, v] of viaApply) expect(v, k).toEqual(viaSync.get(k));
    clearStorages();
  });
});
