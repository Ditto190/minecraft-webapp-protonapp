// 增量光照传播：编辑队列 → 除光+播种 BFS，与全量重算（cascadeLight 收敛级联）逐格一致；
// dirtyChunks 只标光值实际变化的 chunk；邻域有未冲刷全量重算的编辑延迟到基线有效

import { describe, expect, it } from 'vitest';
import { AIR, BLOCK_BY_KEY, STONE } from '../blocks';
import { flushLight } from '../lights';
import { VOID_TERRAIN } from '../noise';
import { CHUNK_SIZE, chunkKey, localIndex, World } from '../world';

const TORCH = BLOCK_BY_KEY.torch.id;
const GLOWSTONE = BLOCK_BY_KEY.glowstone.id;
const SEA_LANTERN = BLOCK_BY_KEY.sea_lantern.id;
const MAGMA = BLOCK_BY_KEY.magma_block.id;

/** 冲刷到队列与脏标记全清（增量编辑若被延迟需多帧） */
function flushAll(w: World): void {
  for (let g = 0; g < 200; g++) {
    flushLight(w);
    let dirty = w.lightEdits.length > 0;
    if (!dirty) for (const c of w.chunks.values()) if (c.lightDirty) { dirty = true; break; }
    if (!dirty) return;
  }
  throw new Error('flushAll 未收敛');
}

/** 全量重算基准：所有 chunk 标脏走 cascadeLight 收敛级联（生成/读档同一条全量路径） */
function fullRecompute(w: World): void {
  w.lightEdits.length = 0;
  for (const c of w.chunks.values()) w.markLightDirty(c);
  flushAll(w);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 建一对相同世界：inc 走增量，full 共享同样数据（每次对拍前由 fullRecompute 重算全量） */
function buildPair(seed: string, build: (w: World) => void): { inc: World; full: World } {
  const inc = new World(seed, undefined, VOID_TERRAIN);
  const full = new World(seed, undefined, VOID_TERRAIN);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) { inc.getChunk(cx, cz); full.getChunk(cx, cz); }
  flushAll(inc);
  flushAll(full);
  build(inc);
  build(full);
  flushAll(inc);
  flushAll(full);
  return { inc, full };
}

function peek(w: World, x: number, y: number, z: number): number {
  const c = w.chunks.get(chunkKey(x >> 4, z >> 4));
  return c ? c.data[localIndex(x & 15, y, z & 15)] : AIR;
}

/** 逐格 diff 两个世界的 light/sky，返回首处不一致的描述（全一致返回 null） */
function diffFirst(a: World, b: World): string | null {
  for (const [k, ca] of a.chunks) {
    const cb = b.chunks.get(k);
    if (!cb) return `chunk ${k} 缺失`;
    for (let i = 0; i < ca.light.length; i++) {
      if (ca.light[i] !== cb.light[i]) return `${k}#${i} light ${ca.light[i]}≠${cb.light[i]}`;
      if (ca.sky[i] !== cb.sky[i]) return `${k}#${i} sky ${ca.sky[i]}≠${cb.sky[i]}`;
    }
  }
  return null;
}

describe('增量光照传播', () => {
  it('随机编辑序列与全量重算逐格一致（火把阵/穿天/边界混合）', () => {
    const { inc, full } = buildPair('inc-diff', (w) => {
      for (let x = -8; x <= 23; x++) for (let z = -8; z <= 23; z++) w.setBlock(x, 40, z, STONE);
      for (let x = 2; x <= 14; x++) {
        for (let z = 2; z <= 14; z++) {
          if (x === 2 || x === 14 || z === 2 || z === 14) for (let y = 41; y <= 44; y++) w.setBlock(x, y, z, STONE);
        }
      }
      // 盖一块屋顶，留出挖穿天的操作面
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) w.setBlock(x, 60, z, STONE);
      w.setBlock(8, 41, 8, TORCH);
      w.setBlock(-1, 41, -1, GLOWSTONE); // 角格光源（跨 chunk 接力）
    });
    const rnd = mulberry32(7);
    const cells: [number, number, number][] = [];
    for (const c of inc.chunks.values()) {
      for (let y = 38; y <= 62; y++) {
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
          for (let lx = 0; lx < CHUNK_SIZE; lx++) cells.push([c.cx * CHUNK_SIZE + lx, y, c.cz * CHUNK_SIZE + lz]);
        }
      }
    }
    const placeable = [STONE, STONE, TORCH, GLOWSTONE, SEA_LANTERN, MAGMA];
    for (let b = 0; b < 30; b++) {
      const n = 1 + ((rnd() * 8) | 0);
      for (let k = 0; k < n; k++) {
        const [x, y, z] = cells[(rnd() * cells.length) | 0];
        const cur = peek(inc, x, y, z);
        const id = cur === AIR ? placeable[(rnd() * placeable.length) | 0] : AIR;
        inc.setBlock(x, y, z, id);
        full.setBlock(x, y, z, id);
      }
      flushAll(inc);
      fullRecompute(full);
      const d = diffFirst(inc, full);
      expect(d, `批 ${b} 后不一致: ${d}`).toBeNull();
    }
  });

  it('爆破同帧批量编辑与全量重算逐格一致', () => {
    const { inc, full } = buildPair('inc-blast', (w) => {
      for (let x = -16; x <= 31; x++) for (let z = -16; z <= 31; z++) for (let y = 30; y <= 46; y++) w.setBlock(x, y, z, STONE);
      w.setBlock(4, 47, 4, GLOWSTONE);
    });
    const rnd = mulberry32(11);
    for (let b = 0; b < 5; b++) {
      const cx = ((rnd() * 24) | 0) - 4;
      const cz = ((rnd() * 24) | 0) - 4;
      const cy = 34 + ((rnd() * 10) | 0);
      const r = 3.5;
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
          for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r && peek(inc, x, y, z) !== AIR) {
              inc.setBlock(x, y, z, AIR);
              full.setBlock(x, y, z, AIR);
            }
          }
        }
      }
      inc.setBlock(cx, cy, cz, TORCH); // 爆破后同帧放光源
      full.setBlock(cx, cy, cz, TORCH);
      flushAll(inc);
      fullRecompute(full);
      const d = diffFirst(inc, full);
      expect(d, `爆破 ${b} 后不一致: ${d}`).toBeNull();
    }
  });

  it('移除光源后邻域独立光源（岩浆块）正确回填', () => {
    const w = new World('inc-magma', undefined, VOID_TERRAIN);
    for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) w.getChunk(cx, cz);
    flushAll(w);
    w.setBlock(23, 44, 16, TORCH);
    w.setBlock(23, 47, 24, MAGMA);
    flushAll(w);
    const c = w.chunks.get(chunkKey(1, 1))!;
    expect(c.light[localIndex(7, 47, 8)]).toBeGreaterThan(2); // 火把照到岩浆旁
    w.setBlock(23, 44, 16, AIR); // 拆火把：岩浆（不透明光源）的 2 级光必须补回
    flushAll(w);
    expect(c.light[localIndex(7, 47, 7)]).toBe(2);
    expect(c.light[localIndex(7, 47, 8)]).toBe(3); // 岩浆自身发光不被误除
  });

  it('dirtyChunks 只标光值实际变化的 chunk（含边界面邻居）', () => {
    const w = new World('inc-dirty', undefined, VOID_TERRAIN);
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.getChunk(cx, cz);
    flushAll(w);

    // 深层无光区挖掘：光照无任何变化 → dirtyChunks 只剩 setBlock 的几何标记
    w.setBlock(4, 5, 4, STONE); // 先埋一个实心块（无光环境）
    flushAll(w);
    w.dirtyChunks.clear();
    w.setBlock(4, 5, 4, AIR); // 再挖开：周围无任何光源
    flushAll(w);
    expect([...w.dirtyChunks].sort()).toEqual(['0,0']); // 只有几何标记，无光追标

    // 暗光源放 chunk 内部：光晕 6 格不触边界 → 只有本 chunk
    w.setBlock(8, 20, 8, BLOCK_BY_KEY.redstone_torch.id);
    flushAll(w);
    expect([...w.dirtyChunks].sort()).toEqual(['0,0']);

    // 拆暗源，换亮火把贴 chunk 边界放：边界层光值变化 → 对面邻居也要重网格化（mesher 采样邻居边界）
    w.setBlock(8, 20, 8, AIR);
    flushAll(w);
    w.dirtyChunks.clear();
    w.setBlock(15, 20, 8, TORCH);
    flushAll(w);
    expect(w.dirtyChunks.has('0,0')).toBe(true);
    expect(w.dirtyChunks.has('1,0')).toBe(true); // 光晕跨 x 边界，对面被点亮
    expect(w.dirtyChunks.has('0,1')).toBe(true); // 光晕同时跨 z 边界（球形的 13 格衰减）
    expect(w.dirtyChunks.has('-1,0')).toBe(false); // 光晕照不到的 chunk 不被误标
    expect(w.dirtyChunks.has('-1,1')).toBe(false);
  });

  it('邻域有未冲刷全量重算时编辑延迟，基线有效后再应用且结果一致', () => {
    const w = new World('inc-defer', undefined, VOID_TERRAIN);
    for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.getChunk(cx, cz);
    flushAll(w);
    // 制造 4 个待全量重算的 chunk 占满预算（每帧 3 个），让 (1,0) 本帧刷不到
    for (const key of ['-1,-1', '-1,0', '-1,1', '1,0']) w.markLightDirty(w.chunks.get(key)!);
    w.setBlock(15, 10, 8, TORCH); // 光会跨进 (1,0)，但 (1,0) 基线无效 → 延迟
    expect(w.lightEdits.length).toBe(5);
    flushLight(w); // 帧 1：预算被前 3 个占满，(1,0) 仍脏 → 编辑保留
    expect(w.lightEdits.length).toBe(5);
    expect(w.chunks.get(chunkKey(1, 0))!.light[localIndex(0, 10, 8)]).toBe(0); // 尚未应用
    flushAll(w); // 帧 2+：邻域冲刷完，编辑应用
    expect(w.lightEdits.length).toBe(0);
    expect(w.chunks.get(chunkKey(1, 0))!.light[localIndex(0, 10, 8)]).toBe(13); // 跨界接力到位
  });

  it('全量语义复刻：不透明边界格承接跨界接力并再扩散', () => {
    const w = new World('inc-relay', undefined, VOID_TERRAIN);
    w.getChunk(0, 0);
    w.getChunk(1, 0);
    flushAll(w);
    w.setBlock(15, 10, 8, STONE); // (0,0) 的 x=15 边界石墙
    w.setBlock(16, 10, 8, TORCH); // (1,0) 的火把贴墙
    flushAll(w);
    const c = w.chunks.get(chunkKey(0, 0))!;
    expect(c.light[localIndex(15, 10, 8)]).toBe(13); // 全量边界接力写入不查不透明度
    expect(c.light[localIndex(14, 10, 8)]).toBe(12); // 接力格继续向 chunk 内扩散
    // 挖掉火把后接力消退
    w.setBlock(16, 10, 8, AIR);
    flushAll(w);
    expect(c.light[localIndex(15, 10, 8)]).toBe(0);
    expect(c.light[localIndex(14, 10, 8)]).toBe(0);
  });

  it('同格连写（放→换→拆→再放）最终态与全量一致', () => {
    const w = new World('inc-rewrite', undefined, VOID_TERRAIN);
    w.getChunk(0, 0);
    w.getChunk(1, 0);
    flushAll(w);
    w.setBlock(15, 10, 8, TORCH);
    w.setBlock(15, 10, 8, GLOWSTONE);
    w.setBlock(15, 10, 8, AIR);
    w.setBlock(15, 10, 8, SEA_LANTERN);
    flushAll(w);
    fullRecompute(w);
    const c = w.chunks.get(chunkKey(0, 0))!;
    expect(c.light[localIndex(15, 10, 8)]).toBe(15); // 海晶灯（不透明光源）
    expect(w.chunks.get(chunkKey(1, 0))!.light[localIndex(0, 10, 8)]).toBe(14);
  });

  it('天光：挖穿与封盖整列段处理与全量一致', () => {
    const w = new World('inc-sky', undefined, VOID_TERRAIN);
    w.getChunk(0, 0);
    flushAll(w);
    // 大屋顶
    for (let x = 0; x <= 15; x++) for (let z = 0; z <= 15; z++) w.setBlock(x, 60, z, STONE);
    flushAll(w);
    const c = w.chunks.get(chunkKey(0, 0))!;
    expect(c.sky[localIndex(8, 59, 8)]).toBeLessThan(15); // 屋顶下方变暗
    // 挖穿屋顶一格：整列补 15
    w.setBlock(8, 60, 8, AIR);
    flushAll(w);
    expect(c.sky[localIndex(8, 59, 8)]).toBe(15);
    expect(c.sky[localIndex(8, 40, 8)]).toBe(15);
    // 侧渗：邻列高度 59 处 14
    expect(c.sky[localIndex(9, 59, 8)]).toBe(14);
    // 封盖回去：整列熄灭回渗光
    w.setBlock(8, 60, 8, STONE);
    flushAll(w);
    expect(c.sky[localIndex(8, 59, 8)]).toBeLessThan(15);
    // 与全量逐格一致
    const before = new Uint8Array(c.sky);
    fullRecompute(w);
    expect(Buffer.from(c.sky).equals(Buffer.from(before))).toBe(true);
  });
});
