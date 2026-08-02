// 方块光照：chunk lightmap（0-15），光源播种 + BFS 衰减传播，跨 chunk 边界接力级联

import { BLOCKS } from './blocks';
import { type Chunk, type World } from './world';
import { CHUNK_SIZE, CHUNK_VOLUME, WORLD_HEIGHT, chunkKey, localIndex } from './grid';

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

// BFS 队列：模块级复用（曾为每次 recomputeLight/recomputeSky 分配 3×CHUNK_VOLUME×2 的 Int16Array ≈ 384KB）。
// lights 的全部调用点（getChunk / applySavedChunk / flushLight → cascadeLight）都在主线程且同步执行到底，
// 无并发、无嵌套重入，模块级单份安全。
// 惰性初始化：world ↔ lights 循环依赖，加载期就读 CHUNK_VOLUME 会在 world 先加载时踩 TDZ
let qx: Int16Array | null = null;
let qy: Int16Array | null = null;
let qz: Int16Array | null = null;
let qh = 0;
let qt = 0;

/** 开一轮新 BFS：重置头尾指针，首次调用时分配队列 */
function qreset(): void {
  if (!qx || !qy || !qz) {
    qx = new Int16Array(CHUNK_VOLUME * 2);
    qy = new Int16Array(CHUNK_VOLUME * 2);
    qz = new Int16Array(CHUNK_VOLUME * 2);
  }
  qh = 0;
  qt = 0;
}

/** 入队；满则倍增扩容（同格可因多次升值重复入队，理论需求 >CHUNK_VOLUME×2，越界写会被静默丢弃导致光照偏低） */
function qpush(x: number, y: number, z: number): void {
  if (qt === qx!.length) {
    const n = qx!.length * 2;
    const nx = new Int16Array(n);
    nx.set(qx!);
    qx = nx;
    const ny = new Int16Array(n);
    ny.set(qy!);
    qy = ny;
    const nz = new Int16Array(n);
    nz.set(qz!);
    qz = nz;
  }
  qx![qt] = x;
  qy![qt] = y;
  qz![qt] = z;
  qt++;
}

/** 重算一个 chunk 的光照（光源 + 邻居边界面接力；不透明方块阻挡） */
export function recomputeLight(world: World, chunk: Chunk): void {
  const light = chunk.light;
  light.fill(0);

  qreset();
  const push = (x: number, y: number, z: number, v: number): void => {
    const i = localIndex(x, y, z);
    if (light[i] >= v) return;
    light[i] = v;
    qpush(x, y, z);
  };

  // 种子 1：本 chunk 内的光源方块
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const lv = BLOCKS[chunk.data[localIndex(x, y, z)]]?.light ?? 0;
        if (lv > 0) push(x, y, z, lv);
      }
    }
  }
  // 种子 2：四邻居边界面光照（跨界衰减 1 接力）
  for (const [dx, dz] of NEIGHBORS) {
    const n = world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
    if (!n) continue;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let t = 0; t < CHUNK_SIZE; t++) {
        let lv: number;
        let x: number;
        let z: number;
        if (dx === 1) {
          lv = n.light[localIndex(0, y, t)];
          x = CHUNK_SIZE - 1;
          z = t;
        } else if (dx === -1) {
          lv = n.light[localIndex(CHUNK_SIZE - 1, y, t)];
          x = 0;
          z = t;
        } else if (dz === 1) {
          lv = n.light[localIndex(t, y, 0)];
          x = t;
          z = CHUNK_SIZE - 1;
        } else {
          lv = n.light[localIndex(t, y, CHUNK_SIZE - 1)];
          x = t;
          z = 0;
        }
        if (lv > 1) push(x, y, z, lv - 1);
      }
    }
  }

  // BFS 衰减传播
  while (qh < qt) {
    const x = qx![qh];
    const y = qy![qh];
    const z = qz![qh];
    qh++;
    const v = light[localIndex(x, y, z)];
    if (v <= 1) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE || ny < 0 || ny >= WORLD_HEIGHT) continue;
      const ni = localIndex(nx, ny, nz);
      if (BLOCKS[chunk.data[ni]]?.opaque) continue;
      push(nx, ny, nz, v - 1);
    }
  }
}

// 列首不透明格高度表（recomputeSky 列式快路用）：模块级复用 + 惰性初始化，理由同上方 BFS 队列
let colTop: Int16Array | null = null;

/** 重算天空光：直降全亮到首个不透明方块，再向侧面衰减渗透（MC 天空光规则） */
export function recomputeSky(world: World, chunk: Chunk): void {
  const sky = chunk.sky;
  sky.fill(0);

  qreset();
  colTop ??= new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  const top = colTop;

  // 1) 垂直直降：每列自天顶连续写 15 直到首个不透明方块，但不再逐格入队（列式快路）。
  // 露天格值全为 15 已达上限，「四邻皆露天」的内部格出队写不出任何新值：任何通往遮光格的
  // 最短路径必先经过一个侧邻非露天的露天格。故只需把 frontier 格（本列露天段中高度 ≤ 某
  // 侧邻列遮光顶的部分，即侧面贴着遮光/不透明格的露天格）入队供侧渗，与旧逐格入队逐格等价
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      let i = ((WORLD_HEIGHT - 1) * CHUNK_SIZE + z) * CHUNK_SIZE + x;
      let y = WORLD_HEIGHT - 1;
      for (; y >= 0; y--) {
        if (BLOCKS[chunk.data[i]]?.opaque) break;
        sky[i] = 15;
        i -= CHUNK_SIZE * CHUNK_SIZE;
      }
      top[x * CHUNK_SIZE + z] = y; // 该列首个不透明格高度（全空列为 -1）
    }
  }
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const own = top[x * CHUNK_SIZE + z];
      let hi = own; // 只需关心遮光顶比本列更高的侧邻（本列露天段在那一高度贴的是遮光格）
      if (x > 0 && top[(x - 1) * CHUNK_SIZE + z] > hi) hi = top[(x - 1) * CHUNK_SIZE + z];
      if (x < CHUNK_SIZE - 1 && top[(x + 1) * CHUNK_SIZE + z] > hi) hi = top[(x + 1) * CHUNK_SIZE + z];
      if (z > 0 && top[x * CHUNK_SIZE + z - 1] > hi) hi = top[x * CHUNK_SIZE + z - 1];
      if (z < CHUNK_SIZE - 1 && top[x * CHUNK_SIZE + z + 1] > hi) hi = top[x * CHUNK_SIZE + z + 1];
      for (let y = own + 1; y <= hi; y++) qpush(x, y, z);
    }
  }

  // 2) 边界接力 + BFS 衰减传播
  const push = (x: number, y: number, z: number, v: number): void => {
    const i = localIndex(x, y, z);
    if (sky[i] >= v) return;
    sky[i] = v;
    qpush(x, y, z);
  };
  for (const [dx, dz] of NEIGHBORS) {
    const n = world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
    if (!n) continue;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let t = 0; t < CHUNK_SIZE; t++) {
        let lv: number;
        let x: number;
        let z: number;
        if (dx === 1) {
          lv = n.sky[localIndex(0, y, t)];
          x = CHUNK_SIZE - 1;
          z = t;
        } else if (dx === -1) {
          lv = n.sky[localIndex(CHUNK_SIZE - 1, y, t)];
          x = 0;
          z = t;
        } else if (dz === 1) {
          lv = n.sky[localIndex(t, y, 0)];
          x = t;
          z = CHUNK_SIZE - 1;
        } else {
          lv = n.sky[localIndex(t, y, CHUNK_SIZE - 1)];
          x = t;
          z = 0;
        }
        if (lv > 1) push(x, y, z, lv - 1);
      }
    }
  }
  while (qh < qt) {
    const x = qx![qh];
    const y = qy![qh];
    const z = qz![qh];
    qh++;
    const v = sky[localIndex(x, y, z)];
    if (v <= 1) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE || ny < 0 || ny >= WORLD_HEIGHT) continue;
      const ni = localIndex(nx, ny, nz);
      if (BLOCKS[chunk.data[ni]]?.opaque) continue;
      push(nx, ny, nz, v - 1);
    }
  }
}

/** 边界光照签名（级联触发比较用；每 2 格采样降低比较成本） */
function borderSign(chunk: Chunk): number {
  let h = 0;
  for (let y = 0; y < WORLD_HEIGHT; y += 2) {
    for (let t = 0; t < CHUNK_SIZE; t += 2) {
      h =
        (h * 31 +
          chunk.light[localIndex(0, y, t)] * 7 +
          chunk.light[localIndex(CHUNK_SIZE - 1, y, t)] * 3 +
          chunk.light[localIndex(t, y, 0)] * 5 +
          chunk.light[localIndex(t, y, CHUNK_SIZE - 1)] +
          chunk.sky[localIndex(0, y, t)] * 11 +
          chunk.sky[localIndex(CHUNK_SIZE - 1, y, t)] * 13 +
          chunk.sky[localIndex(t, y, 0)] * 17 +
          chunk.sky[localIndex(t, y, CHUNK_SIZE - 1)] * 19) |
        0;
    }
  }
  return h;
}

/**
 * 方块变化后级联重算：从变化 chunk 出发，边界签名有变就向邻居扩散（光照最多跨 15 格，
 * 单个编辑的实际级联通常 1-2 个 chunk）
 */
export function cascadeLight(world: World, start: Chunk): void {
  const queue: Chunk[] = [start];
  const seen = new Set<string>([chunkKey(start.cx, start.cz)]);
  while (queue.length > 0) {
    const c = queue.pop()!;
    const before = borderSign(c);
    recomputeLight(world, c);
    recomputeSky(world, c);
    // 顶点色烘焙了光照：重算后必须重网格化，否则跨 chunk 光照接缝滞留
    world.dirtyChunks.add(chunkKey(c.cx, c.cz));
    if (borderSign(c) === before) continue;
    for (const [dx, dz] of NEIGHBORS) {
      const key = chunkKey(c.cx + dx, c.cz + dz);
      if (seen.has(key)) continue;
      const n = world.chunks.get(key);
      if (!n) continue;
      seen.add(key);
      queue.push(n);
    }
  }
}

/**
 * 冲刷标记 lightDirty 的 chunk（批量编辑场景：setBlock 只打标记，
 * 每帧建网前统一重算一次，避免逐 setBlock 全量重算的雪崩）。
 * 每帧限量处理，余下的留到后续帧——大面积光照变化（爆破/放置发光体）
 * 不会在同一帧全部重算而卡住玩家
 */
const FLUSH_BUDGET = 3;

export function flushLight(world: World): void {
  let budget = FLUSH_BUDGET;
  for (const c of world.chunks.values()) {
    if (budget <= 0) break;
    if (!c.lightDirty) continue;
    c.lightDirty = false;
    budget--;
    cascadeLight(world, c);
  }
}
