// updateAround 主线程耗时对比：同步生成（旧路径）vs worker 派发（新路径，注入 dispatcher 模拟派发开销）
// 运行：npx tsx scripts/bench-gen-worker.ts
import { World, type GenApply } from '../lib/world';

const RADIUS = 8; // 默认视距：17×17 = 289 chunk
const CENTER = 2048; // 离原点一段距离，地形有内容

function bench(label: string, fn: () => void): void {
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  console.log(`${label}: ${(t1 - t0).toFixed(2)}ms`);
}

// 旧路径：纯同步生成（等价于改动前 updateAround 单帧全量）
{
  const w = new World('bench-seed');
  bench(`同步生成首帧 updateAround(r=${RADIUS}, 289 chunk)`, () => w.updateAround(CENTER, CENTER, RADIUS, 60_000));
  let max = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    w.updateAround(CENTER + (i + 1) * 16, CENTER, RADIUS, 60_000); // 每步移动 1 chunk，新环同步生成
    max = Math.max(max, performance.now() - t0);
  }
  console.log(`同步生成探索期单帧峰值(移动 1 chunk): ${max.toFixed(2)}ms`);
}

// 游玩期预算路径（改动前）：6ms 预算但单 chunk 15-40ms 超预算
{
  const w = new World('bench-seed');
  w.updateAround(CENTER, CENTER, RADIUS, 60_000);
  let max = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    w.updateAround(CENTER + (i + 1) * 16 + 2048, CENTER, RADIUS, 6);
    max = Math.max(max, performance.now() - t0);
  }
  console.log(`旧 6ms 预算单帧峰值(整 chunk 粒度): ${max.toFixed(2)}ms`);
}

// 新路径：注入 dispatcher（开销≈postMessage+闭包，低于真实 worker 路径的对象构造），apply 不在此计时
{
  const w = new World('bench-seed');
  const inbox = new Map<string, GenApply>();
  w.genDispatch = (cx, cz, apply) => (inbox.set(`${cx},${cz}`, apply), true);
  bench(`worker 派发首帧 updateAround(r=${RADIUS}, 289 chunk)`, () => w.updateAround(CENTER, CENTER, RADIUS, 60_000));
  console.log(`  派发后在途: ${w.pendingGen.size}, 主线程已生成: ${w.chunks.size}`);
  let max = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    w.updateAround(CENTER + (i + 1) * 16 + 4096, CENTER, RADIUS, 6);
    max = Math.max(max, performance.now() - t0);
  }
  console.log(`worker 派发探索期单帧峰值(移动 1 chunk): ${max.toFixed(2)}ms`);
  // 落地成本（applyGeneratedChunk：64KB 拷贝 + 标脏，每帧到达若干个）
  const applies = [...inbox.values()].slice(0, 10);
  const t0 = performance.now();
  for (const apply of applies) apply(new Uint16Array(16 * 16 * 128));
  const t1 = performance.now();
  console.log(`  单次落地回调: ${((t1 - t0) / 10).toFixed(3)}ms`);
}
