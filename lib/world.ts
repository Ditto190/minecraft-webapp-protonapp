// 体素世界：chunk 存储、地形与结构生成、方块读写、脏标记

import { AIR, BLOCK_BY_KEY, BLOCKS } from './blocks';
import { enqueueFluid, needsFluidCheck } from './fluids';
import { notifyCropBlockSet, notifyMoistureBlockSet } from './crops';
import { notifyBlockSet } from './saplings';
import { notifyRedstone } from './redstone';
import { createTerrain, hashString, type Terrain } from './noise';
import { generateNetherChunk } from './nether';
import { generateEndChunk } from './end';
import { cascadeLight } from './lights';
import { getStorage, isStorageBlockId } from './storage';
import { generateChunk, type ChestLoot } from './genCore';
import { getGenPool } from './genPool';

// 网格常量定义在叶子模块 lib/grid.ts（worker 端经 mesher 引用时不会拖入本模块的依赖链）；此处再导出保持既有引用兼容
export { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, localIndex, chunkKey } from './grid';
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, localIndex, chunkKey } from './grid';

// 地形生成管线已抽到叶子模块 lib/genCore.ts（生成 Worker 与主线程同步兜底共用，保证逐格一致）；
// 此处再导出保持既有引用兼容（测试/外部按 '../world' 引入）
export { generateChunk } from './genCore';

/** worker/注入生成完成后的落地回调（data 为 worker 产物，chests 为生成期登记的结构战利品） */
export type GenApply = (data: Uint16Array, chests?: ChestLoot[]) => void;

/** growth.ts 随机刻关心的可生长方块（柱作物：仙人掌/甘蔗/竹子茎与竹顶段），驱动 Chunk.growables 计数 */
const GROWABLE_IDS = new Set<number>([
  BLOCK_BY_KEY.cactus.id,
  BLOCK_BY_KEY.sugar_cane.id,
  BLOCK_BY_KEY.bamboo.id,
  BLOCK_BY_KEY.bamboo_top.id,
]);

export class Chunk {
  readonly data = new Uint16Array(CHUNK_VOLUME);
  /** 方块光照 0-15（lights.ts 维护） */
  readonly light = new Uint8Array(CHUNK_VOLUME);
  /** 天空光 0-15（lights.ts 维护；露天 15，遮光递减） */
  readonly sky = new Uint8Array(CHUNK_VOLUME);
  /** 有未冲刷的光照变更（setBlock 打标记，建网前统一重算） */
  lightDirty = false;
  /** 几何版本号，重建 mesh 时 +1，驱动 React 重新渲染 */
  version = 0;
  /** 被玩家修改过，需要持久化 */
  modified = false;
  /** 可生长方块计数（growth.ts 随机刻关心的仙人掌/甘蔗/竹子；为 0 的 chunk 整 chunk 跳过抽样。
   *  生成/读档时全量扫一次，此后由 setBlock 增减维护） */
  growables = 0;
  constructor(
    public readonly cx: number,
    public readonly cz: number,
  ) {}
}

export class World {
  readonly terrain: Terrain;
  readonly seedHash: number;
  readonly chunks = new Map<string, Chunk>();
  /** 待重建 mesh 的 chunk key */
  readonly dirtyChunks = new Set<string>();
  /** 待全量重算光照的 chunk key（与 dirtyChunks 同模式：标 lightDirty 处登记，flushLight 消费后清除） */
  readonly lightDirtyChunks = new Set<string>();
  /** 待持久化的 chunk key */
  readonly modifiedChunks = new Set<string>();
  /** 有可生长方块（仙人掌/甘蔗/竹子）的 chunk key 集合，tickGrowth 直接遍历，避免扫所有已加载 chunk */
  readonly growableChunks = new Set<string>();
  /** 容器位置注册表：chunkKey → 容器 blockId → 位置 key "x,y,z" 集合。
   *  由 setBlock 同步维护；chunk 卸载时清理；供铜傀儡 O(1) 范围扫描替代 65×65×17 逐格暴力搜 */
  readonly containerRegistry = new Map<string, Map<number, Set<string>>>();
  /** 每列首个不透明方块高度（colKey="x,z"）。setBlock 增量维护；缺失时按需从 chunk 数据重算。
   *  供 exposedToSky 露天候选 O(1) 判定（树叶/水/玻璃 opaque:false 不遮挡）。 */
  readonly colTop = new Map<string, number>();
  /**
   * 光照增量编辑队列（flushLight 逐条做除光+播种 BFS）：打包五元组 x,y,z,oldId,newId。
   * 仅记录不透明度/发光变化的 setBlock；生成/读档 chunk 无旧光照基线，仍走 lightDirty 全量重算
   */
  readonly lightEdits: number[] = [];
  /** chunk 集合变化计数（增删时 +1） */
  generation = 0;
  /** chunk 因超出距离被卸载前回调（用于存档） */
  onChunkRemoved: ((chunk: Chunk) => void) | null = null;
  private readonly saved: Map<string, Uint16Array>;
  /** 已派发给 worker、尚未落地的 chunk key（updateAround 不再重复派发，落地/失败/取消时移除） */
  readonly pendingGen = new Set<string>();
  /**
   * 异步地形生成注入点（测试/自定义调度用；null = 用全局生成 Worker 池）。
   * 返回 true = 已受理；完成后必须调 apply 落地（apply 幂等保护：chunk 已存在则丢弃）
   */
  genDispatch: ((cx: number, cz: number, apply: GenApply) => boolean) | null = null;

  constructor(
    public readonly seed: string,
    saved?: Map<string, Uint16Array>,
    terrain?: Terrain,
  ) {
    this.terrain = terrain ?? createTerrain(seed);
    this.seedHash = hashString(seed);
    this.saved = saved ?? new Map();
  }

  getChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;
    // 有在途的 worker 生成：同步兜底（传送/珍珠/边缘访问等罕见路径）先出结果，
    // 取消在途请求（来不及取消的到达后由 applyGeneratedChunk 的存在性检查丢弃）
    if (this.pendingGen.delete(key)) getGenPool()?.cancel(key);
    const chunk = new Chunk(cx, cz);
    const s = this.saved.get(key);
    if (s && s.length === CHUNK_VOLUME) {
      chunk.data.set(s);
      this.scanGrowables(chunk);
      // 存档恢复的 chunk 光照数组为全 0：标脏交给 flushLight 限流重算（否则世界渲染全黑）
      this.markLightDirty(chunk);
      this.chunks.set(key, chunk);
    } else {
      if (this.terrain.kind === 'nether') generateNetherChunk(this.terrain, cx, cz, chunk.data, this.seedHash);
      else if (this.terrain.kind === 'end') generateEndChunk(this.terrain, cx, cz, chunk.data, this.seedHash);
      else generateChunk(this.terrain, cx, cz, chunk.data, this.seedHash);
      this.scanGrowables(chunk);
      // 先入册再级联：邻居重算的边界接力要能读到本 chunk（否则新 chunk 的光照
      // 传不进既有 chunk，边界单侧陈旧直到下次偶然重算——明暗接缝的源头之一）
      this.chunks.set(key, chunk);
      cascadeLight(this, chunk);
    }
    this.dirtyChunks.add(key);
    // 相邻已存在 chunk 需要重网格化，避免共享边界面重复
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nk = chunkKey(cx + dx, cz + dz);
      if (this.chunks.has(nk)) this.dirtyChunks.add(nk);
    }
    this.generation++;
    return chunk;
  }

  /** getBlock 热路径缓存：上次访问的 chunk 引用（空间局部性极强，省掉每调用的字符串键分配 + Map 查找） */
  private lastChunk: Chunk | null = null;
  private lastChunkCx = 0;
  private lastChunkCz = 0;

  /**
   * updateAround 增量记忆化：
   * - pcx/pcz/radius 为上次铺满时的玩家 chunk 坐标与视距；
   * - keep 为当时应保留的 chunk 位置集合（半径+2 的切比雪夫方形），跨边界时用它做
   *   增量 delta：只加载新进入半径的 chunk、只卸载离开 keep 区的 chunk，避免每帧
   *   全量扫描 this.chunks。
   * null = 缓存无效（首次 / invalidateAround / 加载期未铺满），下次调用全量重扫。
   */
  private aroundCache: { pcx: number; pcz: number; radius: number; keep: Set<string> } | null = null;

  /**
   * 强制下次 updateAround 全量重扫（在坐标/视距不变但世界内容可能突变时使用，
   * 如世界实例复用下的跨维度切换且玩家恰好在同一 chunk 坐标）。
   * World.tsx 每帧调用点无需改动：常规移动/传送靠坐标变化自动失效；
   * 若以后 World.tsx 增加跨维度重置逻辑，可在那里挂一次本调用。
   */
  invalidateAround(): void {
    this.aroundCache = null;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    const cx = x >> 4;
    const cz = z >> 4;
    let c = this.lastChunk;
    if (!c || cx !== this.lastChunkCx || cz !== this.lastChunkCz) {
      c = this.getChunk(cx, cz);
      this.lastChunk = c;
      this.lastChunkCx = cx;
      this.lastChunkCz = cz;
    }
    return c.data[localIndex(x & 15, y, z & 15)];
  }

  /** 该方块坐标所属 chunk 是否已加载（只读查询，不像 getBlock 那样隐式触发生成） */
  isChunkLoaded(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(x >> 4, z >> 4));
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const cx = x >> 4;
    const cz = z >> 4;
    const key = chunkKey(cx, cz);
    const chunk = this.getChunk(cx, cz);
    const oldId = chunk.data[localIndex(x & 15, y, z & 15)];
    chunk.data[localIndex(x & 15, y, z & 15)] = id;
    // 可生长方块计数增减（growth.ts 直接遍历 growableChunks，为 0 的 chunk 整 chunk 跳过）
    if (GROWABLE_IDS.has(oldId)) chunk.growables--;
    if (GROWABLE_IDS.has(id)) chunk.growables++;
    if (chunk.growables > 0) this.growableChunks.add(key);
    else this.growableChunks.delete(key);
    chunk.modified = true;
    this.modifiedChunks.add(key);
    this.dirtyChunks.add(key);
    // 边界方块影响相邻 chunk 的面剔除
    if ((x & 15) === 0) this.markDirty(cx - 1, cz);
    if ((x & 15) === CHUNK_SIZE - 1) this.markDirty(cx + 1, cz);
    if ((z & 15) === 0) this.markDirty(cx, cz - 1);
    if ((z & 15) === CHUNK_SIZE - 1) this.markDirty(cx, cz + 1);
    // 流体进入检查队列（生成过程直接写 data 不走这里，不会触发）；
    // 自身（新/旧值）与 6 邻全无流体则跳过——非流体邻域的编辑占绝大多数
    if (needsFluidCheck(this, x, y, z, oldId, id)) enqueueFluid(x, y, z);
    // 光照变更记入增量队列（建网前由 flushLight 统一做除光+播种 BFS，避免批量编辑雪崩）。
    // 仅当不透明度或发光值变化才需要重算——流水/作物/树叶凋零等非透明变化不影响光照，
    // 大面积水蔓延时这条能省掉成片的无效重算，避免阻塞主线程。
    // chunk 已有全量重算排队（生成/读档无旧光照基线）时无需记录：数据变更会被全量覆盖
    const oldDef = BLOCKS[oldId];
    const newDef = BLOCKS[id];
    if ((oldDef?.opaque ?? false) !== (newDef?.opaque ?? false) || (oldDef?.light ?? 0) !== (newDef?.light ?? 0)) {
      if (!chunk.lightDirty) this.lightEdits.push(x, y, z, oldId, id);
    }
    // 树苗登记 / 原木断供触发树叶凋零（生成过程直接写 data 不走这里）
    notifyBlockSet(this, x, y, z, oldId, id);
    // 小麦作物登记（同上）
    notifyCropBlockSet(x, y, z, id);
    // 耕地湿润缓存增量维护（水/冰/耕地变化时刷新周围 9×9×2 内耕地的邻近有水标记）
    notifyMoistureBlockSet(this, x, y, z, oldId, id);
    // 红石电源登记与粉网络重算（同上）
    notifyRedstone(this, x, y, z, oldId, id);
    // 容器位置注册表与列顶不透明缓存（mobs.ts 扫描优化）
    this.updateContainerRegistry(x, y, z, oldId, id);
    this.updateColTop(x, y, z, oldId, id);
  }

  /** setBlock 钩子：维护 containerRegistry（放置/破坏容器时同步增删） */
  private updateContainerRegistry(x: number, y: number, z: number, oldId: number, newId: number): void {
    const oldContainer = isStorageBlockId(oldId);
    const newContainer = isStorageBlockId(newId);
    if (!oldContainer && !newContainer) return;
    const ck = chunkKey(x >> 4, z >> 4);
    const pk = `${x},${y},${z}`;
    if (oldContainer) {
      const byId = this.containerRegistry.get(ck);
      if (byId) {
        byId.get(oldId)?.delete(pk);
        if (byId.get(oldId)?.size === 0) byId.delete(oldId);
        if (byId.size === 0) this.containerRegistry.delete(ck);
      }
    }
    if (newContainer) {
      let byId = this.containerRegistry.get(ck);
      if (!byId) {
        byId = new Map();
        this.containerRegistry.set(ck, byId);
      }
      let set = byId.get(newId);
      if (!set) {
        set = new Set();
        byId.set(newId, set);
      }
      set.add(pk);
    }
  }

  /** setBlock 钩子：增量维护 colTop（最高不透明方块 y）。破坏列顶时向下重算；放置更高 opaque 则直接更新。 */
  private updateColTop(x: number, y: number, z: number, oldId: number, newId: number): void {
    const oldOpaque = BLOCKS[oldId]?.opaque ?? false;
    const newOpaque = BLOCKS[newId]?.opaque ?? false;
    if (!oldOpaque && !newOpaque) return;
    const key = `${x},${z}`;
    const top = this.colTop.get(key);
    if (newOpaque && (top === undefined || y > top)) {
      this.colTop.set(key, y);
      return;
    }
    if (oldOpaque && top !== undefined && y >= top) {
      const t = this.computeColTop(x, z);
      if (t === undefined) this.colTop.delete(key);
      else this.colTop.set(key, t);
    }
  }

  /** 从 chunk 数据重算某列最高不透明方块；chunk 未加载返回 undefined */
  private computeColTop(x: number, z: number): number | undefined {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return undefined;
    const lx = x & 15;
    const lz = z & 15;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = c.data[localIndex(lx, y, lz)];
      if (id !== AIR && (BLOCKS[id]?.opaque ?? false)) return y;
    }
    return undefined;
  }

  /** 首次查询某列时从已加载 chunk 初始化 colTop */
  getColTop(x: number, z: number): number | undefined {
    const key = `${x},${z}`;
    let v = this.colTop.get(key);
    if (v === undefined) {
      v = this.computeColTop(x, z);
      if (v !== undefined) this.colTop.set(key, v);
    }
    return v;
  }

  private markDirty(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) this.dirtyChunks.add(key);
  }

  /** 登记 chunk 光照全量重算：lightDirty 标记与 lightDirtyChunks 集合同步维护（flushLight 每帧限流消费集合） */
  markLightDirty(chunk: Chunk): void {
    chunk.lightDirty = true;
    this.lightDirtyChunks.add(chunkKey(chunk.cx, chunk.cz));
  }

  /** 全量扫一遍 chunk 数据重计可生长方块数（生成/读档直写 data 后的唯一扫面；此后由 setBlock 增减维护） */
  private scanGrowables(chunk: Chunk): void {
    let n = 0;
    const d = chunk.data;
    for (let i = 0; i < d.length; i++) if (GROWABLE_IDS.has(d[i])) n++;
    chunk.growables = n;
    const key = chunkKey(chunk.cx, chunk.cz);
    if (n > 0) this.growableChunks.add(key);
    else this.growableChunks.delete(key);
  }

  /**
   * 后台加载到的存档数据到达：
   * chunk 未创建 → 存入备用（创建时优先用存档）；已创建但本局未修改 → 替换为存档版本；
   * 本局已有编辑 → 玩家版本优先，忽略存档
   */
  applySavedChunk(key: string, data: Uint16Array): void {
    if (data.length !== CHUNK_VOLUME) return;
    const existing = this.chunks.get(key);
    if (!existing) {
      this.saved.set(key, data);
      return;
    }
    if (existing.modified) return;
    existing.data.set(data);
    this.scanGrowables(existing);
    // 与 getChunk 读档路径（上方 markLightDirty）语义一致：标脏交给 flushLight
    // 每帧限流重算，避免继续游戏时数百个后台存档 chunk 挤在同一个 promise 回调里
    // 同步级联（每个 1-4ms）造成 50-200ms 长任务
    this.markLightDirty(existing);
    this.dirtyChunks.add(key);
    // 边界面可能变化，相邻 chunk 也要重建，避免接缝
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      this.markDirty(existing.cx + dx, existing.cz + dz);
    }
  }

  /** 取出一个待重建 chunk（无则返回 null） */
  pollDirty(): string | null {
    const it = this.dirtyChunks.values().next();
    if (it.done) return null;
    this.dirtyChunks.delete(it.value);
    return it.value;
  }

  /**
   * 派发一个 chunk 的 worker 异步生成（updateAround 热路径）。返回 true = 已受理（在途）；
   * false = 无可用派发通道（池被禁用/Worker 不可用），调用方回退同步 getChunk。
   * 失败（resolve null）时自动移出 pendingGen，下轮重扫重新派发或同步兜底
   */
  private requestGen(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    const apply: GenApply = (data, chests) => {
      this.pendingGen.delete(key);
      this.applyGeneratedChunk(cx, cz, data, chests);
    };
    // 先标记在途再派发：注入的 dispatcher 可能同步调 apply（会自行摘掉标记）
    this.pendingGen.add(key);
    let accepted: boolean;
    if (this.genDispatch) {
      accepted = this.genDispatch(cx, cz, apply);
    } else {
      const pool = getGenPool();
      if (!pool) {
        this.pendingGen.delete(key);
        return false;
      }
      accepted = true;
      void pool.generate(key, this.seed, this.terrain.kind ?? 'overworld', cx, cz).then((r) => {
        // worker 失败/被取消：移出在途标记，下轮 updateAround 重扫时重新派发或同步兜底
        if (r === null) this.pendingGen.delete(key);
        else apply(r.data, r.chests);
      });
    }
    if (!accepted) this.pendingGen.delete(key);
    return accepted;
  }

  /**
   * worker 生成结果落地：建 chunk、挂 dirty（走既有 dirtyChunks→mesherPool 流程）、
   * 光照标脏交 flushLight 每帧限流级联（不回同步 cascadeLight 老路——探索期成批落地时
   * 每个 1-4ms 的级联会叠出长任务；邻居级联正确性由 flushLight 内部 cascadeLight 保证）。
   * 在途期间存档到达的以存档为准（与 getChunk 读档优先语义一致）；chunk 已存在则丢弃
   */
  private applyGeneratedChunk(cx: number, cz: number, data: Uint16Array, chests?: ChestLoot[]): void {
    const key = chunkKey(cx, cz);
    if (data.length !== CHUNK_VOLUME) return;
    if (this.chunks.has(key)) return; // 期间已被同步兜底/读档创建，丢弃
    const chunk = new Chunk(cx, cz);
    const s = this.saved.get(key);
    if (s && s.length === CHUNK_VOLUME) {
      chunk.data.set(s);
    } else {
      // transferable 产物已在主线程（结构化克隆零拷贝转移），这里最后一次落进 chunk 自有数组
      chunk.data.set(data);
      // 生成期登记的结构战利品并回主线程 storages（fillChest 幂等语义：已有内容不覆盖——
      // 内容只取决于 seedHash+坐标，worker 与主线程 roll 出的结果相同，冲突时谁先登记都一样）
      if (chests) {
        for (const [pos, slots] of chests) {
          const st = getStorage(pos);
          if (st.some((sl) => sl !== null)) continue;
          for (let i = 0; i < slots.length && i < st.length; i++) st[i] = slots[i];
          // 将生成期战利品箱登记到容器注册表（玩家未编辑过，但铜傀儡应能作为目标箱）
          const [px, py, pz] = pos.split(',').map(Number);
          const id = chunk.data[localIndex(px & 15, py, pz & 15)];
          if (isStorageBlockId(id)) {
            const ck = chunkKey(px >> 4, pz >> 4);
            let byId = this.containerRegistry.get(ck);
            if (!byId) {
              byId = new Map();
              this.containerRegistry.set(ck, byId);
            }
            let set = byId.get(id);
            if (!set) {
              set = new Set();
              byId.set(id, set);
            }
            set.add(pos);
          }
        }
      }
    }
    this.scanGrowables(chunk);
    this.markLightDirty(chunk);
    this.chunks.set(key, chunk);
    this.dirtyChunks.add(key);
    // 相邻已存在 chunk 需要重网格化，避免共享边界面重复（同 getChunk 加载期标脏逻辑）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nk = chunkKey(cx + dx, cz + dz);
      if (this.chunks.has(nk)) this.dirtyChunks.add(nk);
    }
    this.generation++;
  }

  /**
   * 以 (x, z) 为中心确保半径内 chunk 已生成（由近及远），卸载半径外的 chunk。
   * 无存档的缺失 chunk 优先派发 worker 异步生成（热路径，主线程零生成尖刺）；
   * 有存档的、或 worker 不可用/失败的走 getChunk 同步路径（读档/兜底）。
   * budgetMs 为本次调用的主线程时间预算：异步派发本身极廉价（一次 postMessage），
   * 预算实际只约束同步生成/读档的个数；至少处理 1 个（保证持续推进），此后每个检查一次超时。
   * 返回本轮后仍缺失的 chunk 数（含在途异步；0 = 周围已铺满，调用方据此判定初始加载完成）
   */
  updateAround(x: number, z: number, radius: number, budgetMs = 6): number {
    const pcx = x >> 4;
    const pcz = z >> 4;
    const cache = this.aroundCache;

    // 完全未变：零成本早退。只有「上次已铺满」才写缓存，因此可安全跳过。
    if (cache && cache.pcx === pcx && cache.pcz === pcz && cache.radius === radius) return 0;

    // 决定全量重扫还是增量 delta：
    // - 无缓存、视距变化、玩家瞬移（>1 chunk）时回退全量；
    // - 仅跨 1 个 chunk 边界且所有已加载 chunk 都在旧 keep 区内时做增量，避免遍历整个 this.chunks。
    let fullRecompute = !cache ||
      cache.radius !== radius ||
      Math.abs(cache.pcx - pcx) > 1 ||
      Math.abs(cache.pcz - pcz) > 1;
    if (!fullRecompute && cache) {
      if (this.chunks.size > cache.keep.size) {
        fullRecompute = true; // 已加载数超过 keep 位置数，必有游离 chunk
      } else {
        for (const key of this.chunks.keys()) {
          if (!cache.keep.has(key)) {
            fullRecompute = true; // 发现旧 keep 区外的已加载 chunk
            break;
          }
        }
      }
    }

    const keepR = radius + 2;
    const newKeep = new Set<string>();
    for (let dx = -keepR; dx <= keepR; dx++) {
      for (let dz = -keepR; dz <= keepR; dz++) {
        newKeep.add(chunkKey(pcx + dx, pcz + dz));
      }
    }

    const missing: [number, number, number][] = [];
    const toRemove: string[] = [];

    if (fullRecompute) {
      // 收集缺失 chunk（在途异步生成的不算缺失，不重复派发），按距离由近及远
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const key = chunkKey(pcx + dx, pcz + dz);
          if (!this.chunks.has(key) && !this.pendingGen.has(key)) {
            missing.push([Math.max(Math.abs(dx), Math.abs(dz)), pcx + dx, pcz + dz]);
          }
        }
      }
      // 全量扫描卸载：半径+2 外全部移除
      for (const [key, c] of this.chunks) {
        const dist = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz));
        if (dist > radius + 2) toRemove.push(key);
      }
    } else {
      // 增量：只处理新进入半径的缺失 chunk
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const key = chunkKey(pcx + dx, pcz + dz);
          if (!this.chunks.has(key) && !this.pendingGen.has(key)) {
            missing.push([Math.max(Math.abs(dx), Math.abs(dz)), pcx + dx, pcz + dz]);
          }
        }
      }
      // 增量：只卸载旧 keep 区中现在离开的 chunk（保持原顺序）
      for (const key of cache!.keep) {
        if (!newKeep.has(key) && this.chunks.has(key)) toRemove.push(key);
      }
    }
    missing.sort((a, b) => a[0] - b[0]);

    const start = performance.now();
    let syncDone = 0;
    let asyncReq = 0;
    for (const [, cx, cz] of missing) {
      const key = chunkKey(cx, cz);
      const s = this.saved.get(key);
      // 无存档的走 worker 异步生成；有存档的（生成产物会被存档覆盖，白白浪费 worker 算力）走同步读档
      if ((!s || s.length !== CHUNK_VOLUME) && this.requestGen(cx, cz)) {
        asyncReq++;
      } else {
        try {
          this.getChunk(cx, cz);
        } catch (err) {
          // 单个 chunk 生成异常不堵死调度：下个周期还会重试，其余 chunk 照常生成
          console.error(`chunk ${cx},${cz} 生成失败`, err);
        }
        syncDone++;
      }
      if (performance.now() - start >= budgetMs) break;
    }

    for (const key of toRemove) {
      const c = this.chunks.get(key);
      if (c?.modified) {
        this.onChunkRemoved?.(c);
        // 同步到 saved，回来重建时保留本局编辑（否则会重新生成导致丢失）
        this.saved.set(key, c.data);
      }
      this.chunks.delete(key);
      this.growableChunks.delete(key);
      this.containerRegistry.delete(key);
      // getBlock 缓存的引用若指向被卸载的 chunk：失效（否则读到游离旧数据、且不再触发生成）
      if (c && this.lastChunk === c) this.lastChunk = null;
      this.generation++;
    }
    // 卸载半径外的在途异步请求一并取消（结果必然被丢弃，省 worker 算力）
    for (const key of this.pendingGen) {
      const [gx, gz] = key.split(',').map(Number);
      if (Math.max(Math.abs(gx - pcx), Math.abs(gz - pcz)) > radius + 2) {
        this.pendingGen.delete(key);
        getGenPool()?.cancel(key);
      }
    }
    // 本轮缺失全部落地（含本就无缺失、无在途异步）：记录坐标/视距/keep 集合，之后同位置同视距直接早退；
    // 仍有剩余（预算耗尽/有在途异步未落地）则不缓存，下帧继续推进
    // 仍缺失 = 本轮未处理的 + 在途未落地的（pendingGen 含本轮新派发的，别重复计数）
    const remaining = missing.length - syncDone - asyncReq + this.pendingGen.size;
    if (remaining === 0) this.aroundCache = { pcx, pcz, radius, keep: newKeep };
    return remaining;
  }
}
