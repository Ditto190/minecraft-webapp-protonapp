// 柱状作物生长与仙人掌邻贴规则（MC 随机刻）：甘蔗/仙人掌按 Java age 0→15 计数拔节
// （每次随机刻 age+1，age 满 15 的那次随机刻长一节并清零，等效 16 次随机刻/节）；
// 竹子无 age，每次随机刻 1/3 概率拔节；仙人掌四邻出现实心方块即破，上方各节一并塌落掉落。
// 无登记表——按 MC 随机刻方式从已加载 chunk 随机抽样
//
// 节奏换算（WORLD_HEIGHT=128）：
// - Java 随机刻密度：每游戏刻（1/20s）每个 16³ 子区块抽 3 格（randomTickSpeed=3）
//   → 单格平均 4096/(3×20) ≈ 68.3s 被抽中一次；
//   本实现每 2s 每 chunk 抽 3×(128/16)×40 = 960 格，单格间隔 = 32768/960×2s ≈ 68.3s，与 Java 一致
// - 甘蔗/仙人掌：16 次随机刻/节 → ≈ 1092s ≈ 18 分钟/节（Java 同；
//   旧模型 12 抽样+命中即长 → 单格 5461s/节 ≈ 91 分钟/节，远慢于 Java）
// - 竹子：期望 3 次随机刻/节 → ≈ 205s ≈ 3.4 分钟/节（Java 同）

import { AIR, BLOCK_BY_KEY, BLOCKS, type BlockId } from './blocks';
import { CHUNK_SIZE, WORLD_HEIGHT } from './grid';
import { mulberry32 } from './noise';
import { type World } from './world';
import { registerWorldScope } from './worldScope';

/** 柱高上限（甘蔗/仙人掌为 Java 自然上限 3；竹子取 Java 硬顶 16——Java 靠顶段 stage 机制自然停在 12-16，此处取硬顶） */
const MAX_HEIGHT: Record<string, number> = { cactus: 3, sugar_cane: 3, bamboo: 16 };

/** 每 2s 每 chunk 抽样数：对齐 Java 随机刻密度（3 格/游戏刻/16³ 子区块 × (128/16) 子区块 × 40 游戏刻），换算见文件头 */
const SAMPLES_PER_CHUNK = 3 * (WORLD_HEIGHT / CHUNK_SIZE) * 40;

/** Java：甘蔗/仙人掌 age 满 15 的随机刻拔节（0→15 逐次计数，等效 16 次随机刻/节） */
const MAX_AGE = 15;

/**
 * 柱作物 age 计数（按列 x,z）：甘蔗/仙人掌在 blocks.ts 是单方块注册、无 _0.._N 阶段变体族
 * （不像小麦 wheat_crop_0..7），Java 的 age 方块状态只能以内存 Map 从简实现；不随存档/跨维度保留
 */
const columnAges = new Map<string, number>();
const columnKey = (x: number, z: number): string => `${x},${z}`;

let sampleDebt = 0; // 待处理抽样数：按 dt 以「每拍 SAMPLES_PER_CHUNK 次」的速率折算累计，分数部分留到下次调用
const rand = mulberry32(0x9e3779b9);

/** 水平四邻是否有实心方块 */
function adjacentSolid(world: World, x: number, y: number, z: number): boolean {
  return (
    BLOCKS[world.getBlock(x + 1, y, z)]?.solid === true ||
    BLOCKS[world.getBlock(x - 1, y, z)]?.solid === true ||
    BLOCKS[world.getBlock(x, y, z + 1)]?.solid === true ||
    BLOCKS[world.getBlock(x, y, z - 1)]?.solid === true
  );
}

/** 尝试把所在柱拔高一节（竹子：旧顶段变茎段，新节为带叶顶段） */
function tryGrow(world: World, x: number, y: number, z: number, key: 'cactus' | 'sugar_cane' | 'bamboo'): void {
  const stalk = BLOCK_BY_KEY[key].id;
  const tip = key === 'bamboo' ? BLOCK_BY_KEY.bamboo_top.id : stalk;
  let tipY = y;
  while (world.getBlock(x, tipY + 1, z) === stalk || world.getBlock(x, tipY + 1, z) === tip) tipY++;
  let baseY = y;
  while (world.getBlock(x, baseY - 1, z) === stalk) baseY--;
  if (tipY - baseY + 1 >= MAX_HEIGHT[key]) return;
  if (tipY + 1 >= WORLD_HEIGHT || world.getBlock(x, tipY + 1, z) !== AIR) return;
  if (tip !== stalk) world.setBlock(x, tipY, z, stalk);
  world.setBlock(x, tipY + 1, z, tip);
}

/**
 * 每 ~2s 每 chunk 等效抽 SAMPLES_PER_CHUNK 格（Java 随机刻密度，换算见文件头）。
 * 抽样摊到拍间各次调用上：按 dt 折算本次应抽样本数（一拍节奏与 Java 等效概率密度不变；
 * dt=2 整拍调用时一次抽满 960，与旧的拍边界一次性结算等价），消除拍边界 960×chunk 次
 * getBlock 的集中尖刺。命中规则不变：柱作物仅顶段（上方为空气）计数/拔节——Java 中随机刻
 * 也只作用于顶段，下方茎段被抽中无效；命中贴实心的仙人掌则整列塌落破坏
 */
export function tickGrowth(world: World, dt: number): void {
  sampleDebt += (SAMPLES_PER_CHUNK * dt) / 2;
  const n = Math.floor(sampleDebt);
  if (n <= 0) return;
  sampleDebt -= n;
  for (const chunk of world.chunks.values()) {
    for (let i = 0; i < n; i++) {
      const x = chunk.cx * 16 + Math.floor(rand() * 16);
      const z = chunk.cz * 16 + Math.floor(rand() * 16);
      const y = Math.floor(rand() * WORLD_HEIGHT);
      const id = world.getBlock(x, y, z);
      const key = BLOCKS[id]?.key;
      if (key === 'cactus' && adjacentSolid(world, x, y, z)) {
        // 整列塌落：本格与上方各节一并破坏掉落（与玩家挖掘路径行为一致，MC 规则）
        let cy = y;
        while (world.getBlock(x, cy, z) === id) {
          world.setBlock(x, cy, z, AIR);
          onDrop?.(id, x + 0.5, cy + 0.3, z + 0.5);
          cy++;
        }
        columnAges.delete(columnKey(x, z));
      } else if (key === 'cactus' || key === 'sugar_cane') {
        if (world.getBlock(x, y + 1, z) !== AIR) continue; // 非顶段：随机刻无效（Java）
        // Java age 模型：age<15 则 +1，满 15 拔节并清零
        const ck = columnKey(x, z);
        const age = columnAges.get(ck) ?? 0;
        if (age >= MAX_AGE) {
          columnAges.set(ck, 0);
          tryGrow(world, x, y, z, key);
        } else {
          columnAges.set(ck, age + 1);
        }
      } else if (key === 'bamboo' || key === 'bamboo_top') {
        // Java 竹子：无 age，仅顶段被抽中时 1/3 概率拔节（bamboo_top 为带叶顶段，与茎段同列同效）
        if (world.getBlock(x, y + 1, z) === AIR && rand() < 1 / 3) tryGrow(world, x, y, z, 'bamboo');
      }
    }
  }
}

/** 柱作物 age（测试内省用；未计数的列返回 0） */
export function columnGrowthAge(x: number, z: number): number {
  return columnAges.get(columnKey(x, z)) ?? 0;
}

/** 清空柱作物 age 计数（切换世界/测试隔离） */
export function clearGrowthAges(): void {
  columnAges.clear();
}

// 世界作用域自注册（lib/worldScope.ts）：age 计数随世界清理
registerWorldScope({ name: 'growth', clear: clearGrowthAges });

/** 仙人掌破坏掉落回调（actions 注入，避免循环依赖） */
let onDrop: ((id: BlockId, x: number, y: number, z: number) => void) | null = null;
export function setGrowthDropHandler(fn: typeof onDrop): void {
  onDrop = fn;
}
