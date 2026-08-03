// 地形生成 Worker 池：chunk 方块数据在后台线程生成，探索期主线程不再有 15-40ms 生成尖刺
// 模式同 lib/mesherPool.ts（队列 + 看门狗 + 失败回退）；同 key 重复请求复用在途 Promise
// 结果以 transferable 回传（64KB 不复制）；worker 不可用/连续卡死时返回 null，调用方回退同步生成

import type { DimKind } from './genCore';
import type { GenRequest, GenResponse } from './gen.worker';

const POOL_SIZE = Math.max(2, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4) - 1));

interface Pending {
  key: string;
  resolve: (r: GenResponse | null) => void;
  /** 看门狗计时器：请求发给 worker 后启动（排队中不启动） */
  watchdog?: ReturnType<typeof setTimeout>;
}

interface Queued {
  req: GenRequest;
  pending: Pending;
}

/** worker 无响应判定超时（毫秒）：正常单个 chunk 生成 ~15-40ms，3s 不响应即视为卡死 */
const WATCHDOG_MS = 3000;
/** 连续卡死次数达到即永久禁用池（回退主线程同步生成） */
const MAX_FAILURES = 2;

class GenPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private busy = new Map<Worker, Pending>();
  private queue: Queued[] = [];
  private byKey = new Map<string, Pending>();
  private failures = 0;

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker(new URL('./gen.worker.ts', import.meta.url));
      w.onmessage = (e: MessageEvent<GenResponse>) => this.done(w, e.data);
      w.onerror = (err) => {
        console.warn('[gen] worker 出错，该请求回退主线程', err.message ?? err);
        this.done(w, null);
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** 池是否已被看门狗禁用（worker 持续无响应时回退主线程） */
  get disabled(): boolean {
    return this.failures >= MAX_FAILURES;
  }

  /** 请求生成一个 chunk；resolve null = 失败/取消，调用方回退同步生成。同 key 在途请求复用同一 Promise */
  generate(key: string, seed: string, kind: DimKind, cx: number, cz: number): Promise<GenResponse | null> {
    const prev = this.byKey.get(key);
    if (prev) return new Promise<GenResponse | null>((resolve) => {
      // 包一层不改原 Pending 的 resolve：在途请求落地时两方各收一份（数据只读，无共享可变状态）
      const orig = prev.resolve;
      prev.resolve = (r) => {
        orig(r);
        resolve(r);
      };
    });
    return new Promise<GenResponse | null>((resolve) => {
      const pending: Pending = { key, resolve };
      this.byKey.set(key, pending);
      this.queue.push({ req: { key, seed, kind, cx, cz }, pending });
      this.pump();
    });
  }

  /** 取消排队中的请求（chunk 卸载/同步兜底先生成时调用，省掉必然被丢弃的计算） */
  cancel(key: string): void {
    const pending = this.byKey.get(key);
    if (!pending) return;
    this.byKey.delete(key);
    // busy 中的请求保留看门狗（worker 卡死时槽位需回收），到达后由 World 的存在性检查丢弃
    pending.resolve(null);
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const { req, pending } = this.queue.shift()!;
      // 已被取消的排队任务跳过
      if (this.byKey.get(req.key) !== pending) continue;
      const w = this.idle.pop()!;
      this.busy.set(w, pending);
      // 看门狗：worker 卡死（模块挂起/永不响应）时按失败释放请求，让调用方回退主线程；
      // 连续卡死达到上限则永久禁用池（dev 模式某些运行时 worker 会挂起，不能拖死整个生成管线）
      pending.watchdog = setTimeout(() => {
        console.warn(`[gen] worker ${WATCHDOG_MS}ms 无响应，该请求回退主线程生成`);
        this.failures += 1;
        w.terminate();
        this.busy.delete(w);
        this.workers = this.workers.filter((x) => x !== w); // 已终止，不回 idle
        if (this.byKey.get(pending.key) === pending) this.byKey.delete(pending.key);
        pending.resolve(null);
        if (this.failures >= MAX_FAILURES) {
          console.warn('[gen] worker 连续无响应，永久回退主线程生成');
          for (const ww of this.workers) ww.terminate();
          this.workers.length = 0;
          this.idle.length = 0;
          for (const [, p] of this.byKey) {
            if (p.watchdog) clearTimeout(p.watchdog);
            p.resolve(null);
          }
          this.byKey.clear();
          this.queue.length = 0;
        }
        this.pump();
      }, WATCHDOG_MS);
      w.postMessage(req);
    }
  }

  private done(w: Worker, r: GenResponse | null): void {
    const pending = this.busy.get(w);
    this.busy.delete(w);
    if (this.workers.includes(w)) this.idle.push(w);
    if (pending) {
      if (pending.watchdog) clearTimeout(pending.watchdog);
      // 只在自己仍是注册者时删除——等待期间同 key 可能已被取消并重新注册
      if (this.byKey.get(pending.key) === pending) this.byKey.delete(pending.key);
      else r = null; // 已被取消（结果必然过期），按失败处理
      pending.resolve(r);
    }
    this.pump();
  }
}

let pool: GenPool | null = null;
let poolFailed = false;

/** 全局地形生成池（浏览器端惰性创建；Worker 创建失败时返回 null，调用方回退主线程生成） */
export function getGenPool(): GenPool | null {
  if (typeof Worker === 'undefined' || poolFailed) return null;
  // 调试逃生口：localStorage.mc-no-worker=1 时强制主线程生成（与 mesher 池共用同一开关）
  // 隐私模式下 localStorage 访问可抛 SecurityError：按未设置处理
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('mc-no-worker')) return null;
  } catch {
    // 忽略，按未设置处理
  }
  if (!pool) {
    try {
      pool = new GenPool();
    } catch (err) {
      console.warn('地形生成 Worker 池创建失败，回退主线程生成', err);
      poolFailed = true;
      return null;
    }
  }
  // 看门狗已禁用（worker 连续无响应）：直接回退主线程
  if (pool.disabled) return null;
  // 开发环境调试暴露（自动化实测用）
  if (process.env.NODE_ENV === 'development') (window as unknown as { __genPool?: unknown }).__genPool = pool;
  return pool;
}
