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
 * 单个编辑的实际级联通常 1-2 个 chunk）。inQueue 而非 seen：本 chunk 重算后若又有邻居
 * 边界更新，允许重新入队再算——单波前 seen 会把「先读到旧边界」的陈旧值永久留在 chunk 里
 * （生成期岩浆/水体跨边界时尤其明显）；收敛式级联保证结束后整个影响域到达不动点
 */
export function cascadeLight(world: World, start: Chunk): void {
  const queue: Chunk[] = [start];
  const inQueue = new Set<string>([chunkKey(start.cx, start.cz)]);
  while (queue.length > 0) {
    const c = queue.pop()!;
    inQueue.delete(chunkKey(c.cx, c.cz));
    const before = borderSign(c);
    recomputeLight(world, c);
    recomputeSky(world, c);
    // 顶点色烘焙了光照：重算后必须重网格化，否则跨 chunk 光照接缝滞留
    world.dirtyChunks.add(chunkKey(c.cx, c.cz));
    if (borderSign(c) === before) continue;
    for (const [dx, dz] of NEIGHBORS) {
      const key = chunkKey(c.cx + dx, c.cz + dz);
      if (inQueue.has(key)) continue;
      const n = world.chunks.get(key);
      if (!n) continue;
      inQueue.add(key);
      queue.push(n);
    }
  }
}

// ——— 增量光照传播（MC 式除光+播种 BFS）———
//
// setBlock 把「不透明度/发光变化」的编辑记入 world.lightEdits（打包五元组 x,y,z,oldId,newId），
// flushLight 逐条应用，替代整 chunk 推倒重算：
//   加光（放置光源/挖开遮挡）：变动格取 max(自身发光, 邻值-1)，高于旧值则播种做加光 BFS；
//   除光（移除光源/封盖）：从旧值做除光 BFS——邻格光值小于前沿值说明其光途经旧格，抹到内在地板
//   （块光=自身发光，天光=0）并继续扩散；不小于的格有独立光源，转为重播种点，随后加光 BFS 补回。
// 两种求法同属「max(自身发光, 邻值-1)」的最大不动点（光值 = max over 光源 of 发光-距离，唯一），
// 与全量 recomputeLight/recomputeSky 逐格一致。
// 影响范围上界：光值 ≤15，水平影响 ≤14 格（垂直不限但 chunk 全高同列），故 3×3 chunk 窗口必然闭合；
// 天光另按列处理：挖穿/封盖改变整列「开放」状态（直降 15 段），按段播种/除光，侧渗仍走 BFS。

// 除光队列 [x,y,z,流出旧值]×stride4 与加光队列 [x,y,z]×stride3（值出队时重读，允许重复入队）：
// 模块级复用 + 惰性初始化，单线程同步执行到底，理由同上方 qx/qy/qz
let remQ: Int32Array | null = null;
let addQ: Int32Array | null = null;
let remH = 0;
let remN = 0;
let addH = 0;
let addN = 0;

function remPush(x: number, y: number, z: number, v: number): void {
  if (!remQ) remQ = new Int32Array(4096);
  // 越界写会被静默丢弃（TypedArray 不抛错）导致光照偏低：写入前先扩容，别用 stride 整除判断
  if ((remN + 1) * 4 > remQ.length) {
    const n = new Int32Array(remQ.length * 2);
    n.set(remQ);
    remQ = n;
  }
  const o = remN * 4;
  remQ[o] = x;
  remQ[o + 1] = y;
  remQ[o + 2] = z;
  remQ[o + 3] = v;
  remN++;
}

function addPush(x: number, y: number, z: number): void {
  if (!addQ) addQ = new Int32Array(4096);
  if ((addN + 1) * 3 > addQ.length) {
    const n = new Int32Array(addQ.length * 2);
    n.set(addQ);
    addQ = n;
  }
  const o = addN * 3;
  addQ[o] = x;
  addQ[o + 1] = y;
  addQ[o + 2] = z;
  addN++;
}

// 3×3 chunk 窗口（编辑 chunk 居中）+ 每槽位「边界面变更掩码」（驱动精准重网格化）
const win: (Chunk | null)[] = new Array<Chunk | null>(9).fill(null);
const winMask = new Uint8Array(9);
let winCx = 0;
let winCz = 0;

/** 世界坐标 → 窗口槽位（窗外或未加载返回 -1） */
function winSlot(wx: number, wz: number): number {
  const gx = (wx >> 4) - winCx;
  const gz = (wz >> 4) - winCz;
  if (gx < 0 || gx > 2 || gz < 0 || gz > 2) return -1;
  const s = gz * 3 + gx;
  return win[s] ? s : -1;
}

/** 记录一次实际光值写入的 chunk 边界面（self 位恒置；边界位留给 mesher 的邻域采样依赖） */
function touch(slot: number, lx: number, lz: number): void {
  let m = 1;
  if (lx === 0) m |= 2;
  else if (lx === CHUNK_SIZE - 1) m |= 4;
  if (lz === 0) m |= 8;
  else if (lz === CHUNK_SIZE - 1) m |= 16;
  winMask[slot] |= m;
}

/** 除光 BFS → 重播种 → 加光 BFS（chan 0=块光 1=天光），单条编辑的一个通道跑到底 */
function runChannel(chan: 0 | 1): void {
  while (remH < remN) {
    const o = remH * 4;
    remH++;
    const x = remQ![o];
    const y = remQ![o + 1];
    const z = remQ![o + 2];
    const v = remQ![o + 3];
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const s = winSlot(nx, nz);
      if (s < 0) continue;
      const c = win[s]!;
      const ni = localIndex(nx & 15, ny, nz & 15);
      const id = c.data[ni];
      const arr = chan === 0 ? c.light : c.sky;
      const ln = arr[ni];
      if (ln === 0) continue;
      if (ln < v) {
        // 地板 = 内在值（块光=自身发光；天光=0——开放格值必为 15 ≥ 前沿值，进不了本分支）。
        // ln > fl：该格的光（部分）途经旧格而来 → 抹到地板并继续除光；
        // ln === fl：自足格（纯光源），其值不依赖将逝光，不再除光，只作重播种点
        const fl = chan === 0 ? (BLOCKS[id]?.light ?? 0) : 0;
        if (fl < ln) {
          arr[ni] = fl;
          touch(s, nx & 15, nz & 15);
          remPush(nx, ny, nz, ln);
        }
        if (fl > 0) addPush(nx, ny, nz);
      } else {
        addPush(nx, ny, nz); // 有独立光源/路径：转为重播种点
      }
    }
  }
  while (addH < addN) {
    const o = addH * 3;
    addH++;
    const x = addQ![o];
    const y = addQ![o + 1];
    const z = addQ![o + 2];
    const s0 = winSlot(x, z);
    if (s0 < 0) continue;
    const arr0 = chan === 0 ? win[s0]!.light : win[s0]!.sky;
    const v = arr0[localIndex(x & 15, y, z & 15)];
    if (v <= 1) continue;
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const s = winSlot(nx, nz);
      if (s < 0) continue;
      const c = win[s]!;
      const ni = localIndex(nx & 15, ny, nz & 15);
      // 同 chunk 不写不透明格；跨 chunk 边界面按全量接力语义可写入并继续扩散
      if ((BLOCKS[c.data[ni]]?.opaque ?? false) && s === s0) continue;
      const arr = chan === 0 ? c.light : c.sky;
      if (arr[ni] < v - 1) {
        arr[ni] = v - 1;
        touch(s, nx & 15, nz & 15);
        addPush(nx, ny, nz);
      }
    }
  }
}

/** 把本轮窗口内「光值实际变化」的 chunk 标进 dirtyChunks（含边界面采样依赖的邻居，角格含对角） */
function flushTouched(world: World): void {
  for (let s = 0; s < 9; s++) {
    const m = winMask[s];
    if (m === 0) continue;
    const c = win[s]!;
    const cx = c.cx;
    const cz = c.cz;
    world.dirtyChunks.add(chunkKey(cx, cz));
    if (m & 2) world.dirtyChunks.add(chunkKey(cx - 1, cz));
    if (m & 4) world.dirtyChunks.add(chunkKey(cx + 1, cz));
    if (m & 8) world.dirtyChunks.add(chunkKey(cx, cz - 1));
    if (m & 16) world.dirtyChunks.add(chunkKey(cx, cz + 1));
    if (m & 2 && m & 8) world.dirtyChunks.add(chunkKey(cx - 1, cz - 1));
    if (m & 2 && m & 16) world.dirtyChunks.add(chunkKey(cx - 1, cz + 1));
    if (m & 4 && m & 8) world.dirtyChunks.add(chunkKey(cx + 1, cz - 1));
    if (m & 4 && m & 16) world.dirtyChunks.add(chunkKey(cx + 1, cz + 1));
  }
}

/** 应用一条编辑（两通道各自的播种/除光 + BFS），随后把受影响的 chunk 标记重网格化 */
function applyLightEdit(world: World, x: number, y: number, z: number, oldId: number, newId: number): void {
  winCx = (x >> 4) - 1;
  winCz = (z >> 4) - 1;
  for (let gz = 0; gz < 3; gz++) {
    for (let gx = 0; gx < 3; gx++) {
      win[gz * 3 + gx] = world.chunks.get(chunkKey(winCx + gx, winCz + gz)) ?? null;
      winMask[gz * 3 + gx] = 0;
    }
  }
  const c0 = win[4];
  remH = remN = addH = addN = 0;
  if (!c0) return; // 编辑 chunk 恰被卸载：丢弃（重载时按数据全量重算）
  const lx = x & 15;
  const lz = z & 15;
  const i0 = localIndex(lx, y, lz);
  const oldDef = BLOCKS[oldId];
  const newDef = BLOCKS[newId];
  const opqO = oldDef?.opaque ?? false;
  const opqN = newDef?.opaque ?? false;
  const eO = oldDef?.light ?? 0;
  const eN = newDef?.light ?? 0;

  // 不透明格的全量语义：max(自身发光, 跨 chunk 边界接力)——边界接力播种不查不透明度；
  // 仅取「跨界」邻格（本格在 chunk 边界时对面那一格），同 chunk 邻格不向不透明格供给
  const crossBorderMax = (arr: (c: { light: Uint8Array; sky: Uint8Array }) => Uint8Array): number => {
    let m = 0;
    for (const [dx, dz] of NEIGHBORS) {
      const cross = (dx === 1 && lx === CHUNK_SIZE - 1) || (dx === -1 && lx === 0) || (dz === 1 && lz === CHUNK_SIZE - 1) || (dz === -1 && lz === 0);
      if (!cross) continue;
      const s = winSlot(x + dx, z + dz);
      if (s < 0) continue;
      const v = arr(win[s]!)[localIndex((x + dx) & 15, y, (z + dz) & 15)] - 1;
      if (v > m) m = v;
    }
    return m;
  };

  // —— 块光通道 ——
  const L = c0.light;
  const oldL = L[i0];
  if (eN < eO) {
    // 光源变暗/移除（含不透明发光体被挖）：除光，地板 = 新内在发光
    if (oldL !== eN) {
      L[i0] = eN;
      touch(4, lx, lz);
    }
    remPush(x, y, z, oldL > eO ? oldL : eO); // 一致态下 oldL ≥ eO；max 防御瞬时不一致
    if (eN > 0) addPush(x, y, z);
  } else if (opqN) {
    // 变不透明：新值 = max(自身发光, 跨界接力)；降值除光（地板=自身发光，接力由重播种补回）
    const target = Math.max(eN, crossBorderMax((c) => c.light));
    if (target > oldL) {
      L[i0] = target;
      touch(4, lx, lz);
      addPush(x, y, z);
    } else if (target < oldL) {
      L[i0] = eN;
      touch(4, lx, lz);
      remPush(x, y, z, oldL);
      if (eN > 0) addPush(x, y, z);
    }
  } else if (opqO) {
    // 挖开成透明格：新可达值 = max(自身发光, 邻值-1)，只升不降
    let seed = eN;
    for (const [dx, dy, dz] of DIRS) {
      const ny = y + dy;
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const s = winSlot(x + dx, z + dz);
      if (s < 0) continue;
      const v = win[s]!.light[localIndex((x + dx) & 15, ny, (z + dz) & 15)] - 1;
      if (v > seed) seed = v;
    }
    if (seed > oldL) {
      L[i0] = seed;
      touch(4, lx, lz);
      addPush(x, y, z);
    }
  } else if (eN > eO && eN > oldL) {
    // 透明→更亮的光源：仅在超过现值时播种（现值更亮说明邻域已有更强光源）
    L[i0] = eN;
    touch(4, lx, lz);
    addPush(x, y, z);
  }
  runChannel(0);

  // —— 天空光通道（只随不透明度变化）——
  if (opqO !== opqN) {
    const S = c0.sky;
    const oldS = S[i0];
    if (opqN) {
      // 封盖：本格新值 = 跨界接力（可能 >0）；若原本直降开放（sky==15 ⟺ 列开放），
      // 下方连续开放段一并熄灭。接力值由除光后的重播种写回
      const target = crossBorderMax((c) => c.sky);
      if (target > oldS) {
        // 暗处封盖但对面亮：接力升（接力格会再向同 chunk 侧扩散）
        S[i0] = target;
        touch(4, lx, lz);
        addPush(x, y, z);
      } else {
        if (oldS !== 0) {
          S[i0] = 0;
          touch(4, lx, lz);
          remPush(x, y, z, oldS);
        }
        if (oldS === 15) {
          for (let yy = y - 1; yy >= 0; yy--) {
            const ii = localIndex(lx, yy, lz);
            if (BLOCKS[c0.data[ii]]?.opaque || S[ii] !== 15) break;
            S[ii] = 0;
            touch(4, lx, lz);
            remPush(x, yy, z, 15);
          }
        }
      }
    } else {
      // 挖开：正上方开放（或已在世界顶）→ 本格与下方连续透明段全部补 15；否则按邻渗候选播种
      const open = y + 1 >= WORLD_HEIGHT || S[localIndex(lx, y + 1, lz)] === 15;
      if (open) {
        if (S[i0] !== 15) {
          S[i0] = 15;
          touch(4, lx, lz);
        }
        addPush(x, y, z);
        for (let yy = y - 1; yy >= 0; yy--) {
          const ii = localIndex(lx, yy, lz);
          if (BLOCKS[c0.data[ii]]?.opaque) break;
          if (S[ii] !== 15) {
            S[ii] = 15;
            touch(4, lx, lz);
          }
          addPush(x, yy, z);
        }
      } else {
        let cand = 0;
        for (const [dx, dy, dz] of DIRS) {
          const ny = y + dy;
          if (ny < 0 || ny >= WORLD_HEIGHT) continue;
          const s = winSlot(x + dx, z + dz);
          if (s < 0) continue;
          const v = win[s]!.sky[localIndex((x + dx) & 15, ny, (z + dz) & 15)] - 1;
          if (v > cand) cand = v;
        }
        if (cand > oldS) {
          S[i0] = cand;
          touch(4, lx, lz);
          addPush(x, y, z);
        }
      }
    }
    runChannel(1);
  }
  flushTouched(world);
}

/** 逐条应用编辑队列；邻域 8 chunk 有未冲刷全量重算（光图非有效基线）的编辑留到下一帧 */
function drainLightEdits(world: World): void {
  const edits = world.lightEdits;
  if (edits.length === 0) return;
  let out = 0;
  for (let i = 0; i < edits.length; i += 5) {
    const x = edits[i];
    const y = edits[i + 1];
    const z = edits[i + 2];
    const oldId = edits[i + 3];
    const newId = edits[i + 4];
    const cx = x >> 4;
    const cz = z >> 4;
    const c = world.chunks.get(chunkKey(cx, cz));
    // 已卸载 → 丢弃（重载时按数据全量重算）；本 chunk 待全量重算 → 数据变更已被覆盖，丢弃
    if (!c || c.lightDirty) continue;
    let defer = false;
    for (let dz = -1; dz <= 1 && !defer; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = world.chunks.get(chunkKey(cx + dx, cz + dz));
        if (n?.lightDirty) {
          defer = true;
          break;
        }
      }
    }
    if (defer) {
      edits[out] = x;
      edits[out + 1] = y;
      edits[out + 2] = z;
      edits[out + 3] = oldId;
      edits[out + 4] = newId;
      out += 5;
      continue;
    }
    applyLightEdit(world, x, y, z, oldId, newId);
  }
  edits.length = out;
}

/**
 * 冲刷光照变更（每帧建网前统一执行，批量编辑不会逐 setBlock 重算雪崩）：
 * 1) 生成/读档 chunk 没有「旧光照」基线——仍走 lightDirty 全量重算，每帧限量摊销；
 * 2) 玩家编辑走增量传播（从变动格除光+播种 BFS），只重网格化光值实际变化的 chunk。
 */
const FLUSH_BUDGET = 3;

export function flushLight(world: World): void {
  let budget = FLUSH_BUDGET;
  // 直接消费 lightDirty 集合（world.markLightDirty 登记），不再每帧全扫 world.chunks
  for (const key of world.lightDirtyChunks) {
    if (budget <= 0) break;
    world.lightDirtyChunks.delete(key); // 迭代中删除当前元素是安全的；已卸载的 chunk 一并清出集合
    const c = world.chunks.get(key);
    if (!c || !c.lightDirty) continue;
    c.lightDirty = false;
    budget--;
    cascadeLight(world, c);
  }
  drainLightEdits(world);
}
