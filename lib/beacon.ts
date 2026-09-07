// 信标：矿物块金字塔（1-4 层）+ 信标激活，消耗矿物锭选效果，范围内玩家持续获得增益（MC 规则）
//
// 金字塔：第 n 层是信标正下方 y-n 处 (2n+1)×(2n+1) 的实心矿物块（铁/金/钻石/绿宝石块）。
// 层数决定可选效果与范围：1 层 速度/急迫（20 格），2 层 +抗性/跳跃（30），3 层 +力量（40），4 层 范围 50。
// 4 层副效果（MC：生命恢复 I 级 或 主效果 II 级二选一）：生命恢复在循环列表末尾可选；其余主效果在 4 层自动 II 级——生效等级写在 beaconTiers 供消费端读取。

import { BLOCK_BY_KEY, BLOCKS } from './blocks';
import { effects, type Effects } from './effects';
import { type World } from './world';
import { WORLD_HEIGHT } from './grid';
import { registerWorldScope } from './worldScope';

/** 可搭建金字塔的矿物块（MC：铁块/金块/钻石块/绿宝石块） */
const PYRAMID_IDS = new Set(
  (['iron_block', 'gold_block', 'diamond_block', 'emerald_block'] as const).map((k) => BLOCK_BY_KEY[k].id),
);

/** 可选效果：minLevel 为解锁所需金字塔层数（MC 层级表）；4 层追加生命恢复（MC 副效果二选一：生命恢复 I 级 或 主效果 II 级） */
export const BEACON_EFFECTS: { minLevel: number; key: keyof Effects; name: string }[] = [
  { minLevel: 1, key: 'speed', name: '速度' },
  { minLevel: 1, key: 'haste', name: '急迫' },
  { minLevel: 2, key: 'resistance', name: '抗性提升' },
  { minLevel: 2, key: 'jumpBoost', name: '跳跃提升' },
  { minLevel: 3, key: 'strength', name: '力量' },
  { minLevel: 4, key: 'regen', name: '生命恢复' },
];

/** MC 范围：1-4 层对应 20/30/40/50 格（水平半径，垂直向上不限） */
export const BEACON_RANGE = [0, 20, 30, 40, 50];

/** 用于激活/支付的矿物锭（MC：铁锭/金锭/钻石/绿宝石/下界合金锭任一） */
export const BEACON_PAYMENTS = new Set(['iron_ingot', 'gold_ingot', 'diamond', 'emerald', 'netherite_ingot']);

/** 信标上方是否无遮挡见天空（MC：被不透明方块遮挡即失效；玻璃等透明方块不算遮挡）。
 *  只沿本列向上查（同 chunk），不会触发未加载 chunk 生成 */
export function hasSkyAccess(world: World, x: number, y: number, z: number): boolean {
  for (let ty = y + 1; ty < WORLD_HEIGHT; ty++) {
    if (BLOCKS[world.getBlock(x, ty, z)]?.opaque) return false;
  }
  return true;
}

/** 扫描信标 (x,y,z) 下方金字塔层数（0-4）；逐层向外扩，缺一块即止；上方无天空视野视为 0（MC） */
export function scanPyramid(world: World, x: number, y: number, z: number): number {
  if (!hasSkyAccess(world, x, y, z)) return 0;
  let level = 0;
  for (let n = 1; n <= 4; n++) {
    const ly = y - n;
    let ok = true;
    for (let dx = -n; dx <= n && ok; dx++) {
      for (let dz = -n; dz <= n; dz++) {
        if (!PYRAMID_IDS.has(world.getBlock(x + dx, ly, z + dz))) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) break;
    level = n;
  }
  return level;
}

export interface ActiveBeacon {
  x: number;
  y: number;
  z: number;
  effect: keyof Effects;
}

/** 已激活的信标：posKey → 所选效果（随维度暂存并经存档 dims.beacons 持久化，读档后仍激活、右击切换不再收费） */
export const activeBeacons = new Map<string, ActiveBeacon>();

/** 光柱渲染等监听激活表变更的版本号（React 订阅用） */
export const beaconVersion = { v: 0 };

/** 4 层金字塔副效果（MC 简化：主效果自动 II 级）：玩家在范围内时由 tickBeacons 刷新为 2，否则无条目（=I 级）。
 *  消费端（Player 速度/跳跃/力量、store 抗性、挖掘急迫）读此表把 I 级幅度升为 II 级。 */
export const beaconTiers = new Map<keyof Effects, 1 | 2>();

export function beaconKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/** 右击信标：未激活→消耗 1 矿物锭激活默认效果；已激活→在金字塔层数允许的列表中循环切换（不再耗锭）。
 *  heldMaterial 为当前手持材料名（无则 null）。返回提示文案，null 表示无需提示。 */
export function interactBeacon(
  world: World,
  x: number,
  y: number,
  z: number,
  heldMaterial: string | null,
): { notice: string; consume: string | null; ok: boolean } {
  const level = scanPyramid(world, x, y, z);
  if (level === 0) return { notice: '信标需要矿物块金字塔（铁/金/钻石/绿宝石块）', consume: null, ok: false };
  const key = beaconKey(x, y, z);
  const cur = activeBeacons.get(key);
  const avail = BEACON_EFFECTS.filter((e) => e.minLevel <= level);
  // 4 层时主效果 II 级；生命恢复恒 I 级（MC 副效果二选一）
  const suffix = (key: keyof Effects) => (level >= 4 && key !== 'regen' ? ' II' : '');
  if (cur) {
    // 若金字塔加高解锁了更多效果，切换列表也随之变长
    const idx = avail.findIndex((e) => e.key === cur.effect);
    const next = avail[(idx + 1) % avail.length];
    cur.effect = next.key;
    return { notice: `信标：${next.name}${suffix(next.key)}`, consume: null, ok: true };
  }
  if (!heldMaterial || !BEACON_PAYMENTS.has(heldMaterial)) {
    return { notice: `金字塔 ${level} 层——手持铁锭/金锭/钻石/绿宝石/下界合金锭右击激活`, consume: null, ok: false };
  }
  activeBeacons.set(key, { x, y, z, effect: avail[0].key });
  beaconVersion.v++;
  return { notice: `信标激活：${avail[0].name}${suffix(avail[0].key)}`, consume: heldMaterial, ok: true };
}

/** tickBeacons 的 tiers 暂存表（模块级复用，避免每帧 new Map；beaconTiers 是导出引用不可换绑，只能原地同步） */
const tiersScratch = new Map<keyof Effects, 1 | 2>();

/** 每 tick：校验激活信标的金字塔仍在（损坏则失效），范围内玩家刷新所选效果（MC 每 4s 施加 11s，简化为持续刷新 5s）；
 *  4 层金字塔的主效果登记为 II 级（beaconTiers；生命恢复恒 I 级，MC 副效果二选一）。
 *  金字塔层数不做跨调用缓存：信标失效须在下一次扫描立即可见（setBlock 无同步通知渠道可订阅）；
 *  每帧调用点经 tickBeaconsThrottled 节流到 0.5s（MC Java 4s 重算的低成本版）；无信标（绝大多数帧）走早退零开销 */
export function tickBeacons(world: World, px: number, py: number, pz: number): void {
  // 无激活信标直接返回：此时 beaconTiers 必已空（失效/清空路径都会重建），防御性 clear 兜底
  if (activeBeacons.size === 0) {
    if (beaconTiers.size > 0) beaconTiers.clear();
    return;
  }
  const tiers = tiersScratch;
  for (const [key, b] of activeBeacons) {
    const level = world.getBlock(b.x, b.y, b.z) !== BLOCK_BY_KEY.beacon.id ? 0 : scanPyramid(world, b.x, b.y, b.z);
    if (level === 0) {
      activeBeacons.delete(key);
      beaconVersion.v++;
      continue;
    }
    const r = BEACON_RANGE[level];
    // MC：水平半径 r，垂直向下 r、向上直到建筑限高
    if (Math.abs(px - b.x - 0.5) <= r && Math.abs(pz - b.z - 0.5) <= r && py >= b.y - r) {
      effects[b.effect] = Math.max(effects[b.effect], 5);
      if (level >= 4 && b.effect !== 'regen') tiers.set(b.effect, 2); // 4 层副效果：主效果 II 级（生命恢复恒 I 级；多只 4 层信标同效果同为 II）
    }
  }
  // 原地同步 beaconTiers（消费端持有导出引用）：删失效键、写当前键
  for (const k of beaconTiers.keys()) if (!tiers.has(k)) beaconTiers.delete(k);
  for (const [k, v] of tiers) beaconTiers.set(k, v);
  tiers.clear();
}

/** 清空（测试/重置用） */
export function clearBeacons(): void {
  activeBeacons.clear();
  beaconTiers.clear();
  beaconVersion.v++;
  lastBeaconTickAt = -Infinity; // 复位节流：下次 tickBeaconsThrottled 立即重扫
}

/** tickBeacons 节流间隔（秒）：MC Java 本体 80 tick（4s）才重算一次；取 0.5s 兼顾失效响应——
 *  效果一次刷新 5s 远长于间隔，范围内玩家无感知（金字塔损坏最多晚 0.5s 失效） */
export const BEACON_TICK_INTERVAL = 0.5;
/** 上次全量重扫的时间戳（秒；-Infinity = 尚未扫过，首帧必扫） */
let lastBeaconTickAt = -Infinity;

/** 节流版 tickBeacons：间隔内复用上次校验结果（激活信标时每帧全量扫 = 每信标 hasSkyAccess 列扫描 + scanPyramid 164 次 getBlock） */
export function tickBeaconsThrottled(world: World, px: number, py: number, pz: number, nowSec: number): void {
  if (nowSec - lastBeaconTickAt < BEACON_TICK_INTERVAL) return;
  lastBeaconTickAt = nowSec;
  tickBeacons(world, px, py, pz);
}

// 世界作用域自注册（lib/worldScope.ts）：激活的信标随维度暂存/恢复（防跨维度误删），并经 persistence dims.beacons 落盘
registerWorldScope<[string, ActiveBeacon][]>({
  name: 'beacon',
  clear: clearBeacons,
  snapshot: () => [...activeBeacons],
  restore: (entries) => {
    activeBeacons.clear();
    for (const [k, v] of entries) activeBeacons.set(k, v);
  },
});
