// 流体传播（水源 + 流水 1-7 级；岩浆源 + 流动岩浆 1-7 级）：队列驱动、每 tick 限量。
// 水：传播 + 消退 + 无限水源（对齐 MC）。
// 流体冲毁（对齐 Java 流体破坏表）：水/岩浆流入花/草/火把/红石粉/雪层/甘蔗/藤蔓/作物等非实心格会破坏方块——
// 水按挖掘规则弹出掉落物（收割水流、水熄火把依赖此），岩浆只销毁不掉落（MC）。
// 下落流体（MC falling）：源垂直下落的水柱/岩浆柱保持源强度（格内存 1 级流 id，falling 集合标记），
// 落地后从 1 级起扩满（水 7 格、主世界岩浆 3 格）；falling 不是源、不参与无限水成源（MC）。
// 岩浆（对齐 MC Java）：主世界/末地水平流 3 格（level 1-3）、下界 7 格（level 1-7），向下流动与水相同；
// 节奏主世界/末地每 1.5s（30 tick）一步、下界每 0.5s（10 tick）一步——sim.ts 慢节奏一拍 0.4s，
// 用本模块内部 accumulator 折算（0.4s 粒度下主世界约每 4 拍一步、下界约每 1-2 拍一步）。
// 水火反应（对齐 Java 圆石/石头/黑曜石规则）：
// - 侧向流入水的岩浆 / 水流入流动岩浆 → 圆石
// - 岩浆向下流入水 → 石头
// - 岩浆源遇水一律黑曜石（任意方向接触，含水从上方浇到源上）
// 岩浆消退（对齐 MC：断源后逐级枯竭）：源头被挖/被反应消耗后，下游流动岩浆按等级逐级消退，
// 节奏与扩散一致（主世界/末地 1.5s、下界 0.5s 每级）——消退判定在岩浆步里做，setBlock 入队邻居带动下一级。
// 无限岩浆源规则：MC 岩浆不像水能成源，流动岩浆永不生成新源（本实现 tickLava 无任何成源路径，天然满足）。

import { AIR, BLOCK_BY_KEY, BLOCKS, COBBLE, isColumnPlantId, isLavaId, isWaterId, LAVA, LAVA_FLOW_1, STONE, WATER, WATER_FLOW_1, WHEAT_CROP_0, type BlockId } from './blocks';
import { spawnBlockDrop, spawnMaterialDrop } from './items';
import type { World } from './world';
import { registerWorldScope } from './worldScope';

const FLOW_BASE = WATER_FLOW_1;
const FLOW_MAX = FLOW_BASE + 6; // WATER_FLOW_7

const LAVA_FLOW_BASE = LAVA_FLOW_1;
const LAVA_FLOW_MAX = LAVA_FLOW_BASE + 6; // LAVA_FLOW_7

/** 水位等级：源 0，流水 1-7；非水返回 -1 */
export function waterLevel(id: BlockId): number {
  if (id === WATER) return 0;
  if (id >= FLOW_BASE && id <= FLOW_MAX) return id - FLOW_BASE + 1;
  return -1;
}

/** 岩浆位等级：源 0，流动岩浆 1-7；非岩浆返回 -1 */
export function lavaLevel(id: BlockId): number {
  if (id === LAVA) return 0;
  if (id >= LAVA_FLOW_BASE && id <= LAVA_FLOW_MAX) return id - LAVA_FLOW_BASE + 1;
  return -1;
}

/**
 * 队列键数字打包：x,y,z 三轴平铺需 26+26+8=60 位，超出安全整数位宽（2^53），
 * 故用「列键 → y 集合」两层结构：列键 = (x+2^25)·2^26 + (z+2^25) < 2^52（安全整数内，精确可还原），
 * y∈[0,WORLD_HEIGHT) 作内层 Set 元素。坐标范围 |x|,|z| < 2^25（±3355 万格，覆盖 MC 3000 万世界边界）
 */
const XZ_OFF = 1 << 25;
const XZ_SPAN = 1 << 26;
const colKeyOf = (x: number, z: number): number => (x + XZ_OFF) * XZ_SPAN + (z + XZ_OFF);

type CellMap = Map<number, Set<number>>;

function addCell(m: CellMap, x: number, y: number, z: number): void {
  const col = colKeyOf(x, z);
  let ys = m.get(col);
  if (!ys) m.set(col, (ys = new Set()));
  ys.add(y);
}

function hasCell(m: CellMap, x: number, y: number, z: number): boolean {
  return m.get(colKeyOf(x, z))?.has(y) ?? false;
}

function deleteCell(m: CellMap, x: number, y: number, z: number): void {
  const col = colKeyOf(x, z);
  const ys = m.get(col);
  if (!ys) return;
  ys.delete(y);
  if (ys.size === 0) m.delete(col);
}

/** 流体检查队列（数字打包键，见上；tickFluids 拍快照整体换出，故用 let） */
let pending: CellMap = new Map();
/** 本拍内新生成的流水/流动岩浆格：留到下一拍才结算（新生格可能已在拍开始时的队列快照里，仅靠换出快照挡不住同拍级联） */
const created: CellMap = new Map();
/** 下落流体格（MC falling）：源垂直下流形成、强度等同源；格内存 1 级流 id，靠本集合识别。
 *  falling 不是源（无限水判定只认 WATER id，天然排除）、也不能转源（tickWater 跳过成源）。
 *  仅存内存：读档后旧水柱退化为普通 1 级流，再次扩散少 1 格（已有水潭靠消退链自维持，观感无损）。 */
const falling: CellMap = new Map();

/** 水平四邻 / 六邻方向表（模块常量：tickWater/tickLava 热循环内不再建数组字面量） */
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]] as const;

/**
 * 可被流体冲毁的非实心方块（对齐 Java 流体破坏表）：水流入破坏并按挖掘规则掉落，岩浆流入只销毁（MC）。
 * 保守排除：压力板/门/床（审计明确留出）、睡莲（浮于水面）、仙人掌/竹子/滴水石笋/紫水晶簇/紫颂花（拿不准，按挡水处理）；
 * 红石火把/中继器/比较器 Java 同样会被冲毁，本轮审计未列入，暂按挡水处理（待确认后补）。
 */
const WASHABLE_KEYS = [
  // 花（Java 可替代植物）
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'oxeye_daisy', 'cornflower', 'red_tulip', 'white_tulip',
  // 草/蕨（含双格高的两段）
  'short_grass', 'fern', 'tall_grass', 'tall_grass_top', 'large_fern', 'large_fern_top',
  // 树苗
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling', 'mangrove_sapling', 'cherry_sapling',
  // 蘑菇/菌类/菌索/枯灌木/杜鹃花丛（Java 同为可替代植物）
  'red_mushroom', 'brown_mushroom', 'warped_fungus', 'crimson_fungus', 'warped_roots', 'crimson_roots',
  'dead_bush', 'azalea', 'flowering_azalea',
  // 火把（含贴墙款，统一掉落地火把）
  'torch', 'torch_wall_n', 'torch_wall_e', 'torch_wall_s', 'torch_wall_w',
  // 红石粉/拉杆/按钮
  'redstone_dust', 'lever', 'lever_on', 'oak_button', 'oak_button_on', 'stone_button', 'stone_button_on',
  // 雪层/藤蔓（含洞穴藤蔓）/甘蔗/地狱疣
  'snow_layer', 'vine_n', 'vine_e', 'vine_s', 'vine_w', 'cave_vines', 'sugar_cane', 'nether_wart',
];
const WASHABLE = new Set<BlockId>(WASHABLE_KEYS.map((k) => BLOCK_BY_KEY[k].id));
for (let stage = 0; stage <= 7; stage++) WASHABLE.add(WHEAT_CROP_0 + stage); // 小麦作物（MC：收割水流冲毁）

/** sim.ts 慢节奏拍长（秒）：tickFluids 每拍调用一次，本模块按拍累计模拟时间 */
const BEAT = 0.4;
/** 岩浆扩散一步的间隔（秒；MC Java：主世界/末地 30 tick，下界 10 tick） */
const LAVA_INTERVAL_NORMAL = 1.5;
const LAVA_INTERVAL_NETHER = 0.5;
let lavaAcc = 0;

/** 方块变动时把自身与邻居加入流体检查队列（world.setBlock 统一调用） */
export function enqueueFluid(x: number, y: number, z: number): void {
  addCell(pending, x, y, z);
  addCell(pending, x + 1, y, z);
  addCell(pending, x - 1, y, z);
  addCell(pending, x, y, z + 1);
  addCell(pending, x, y, z - 1);
  addCell(pending, x, y - 1, z);
  addCell(pending, x, y + 1, z); // 上方格：挖掉水下的方块，上方水才能流下补坑
}

const isFluidId = (id: BlockId): boolean => isWaterId(id) || isLavaId(id);

/**
 * setBlock 入队门控：自身（新/旧值）或 6 邻任一格是流体才有流体结算的需要——
 * 非流体邻域的编辑占绝大多数，7 格判定（getBlock 有 lastChunk 缓存，便宜）省掉每次编辑 7 次入队操作。
 * 判定在数据写入后调用：6 邻不受本次写入影响，自身用新/旧 id 显式覆盖。
 * 水平邻格跨进未加载 chunk 时不读块（getBlock 会隐式触发全量生成），保守入队——与旧的无条件入队同语义
 */
export function needsFluidCheck(world: World, x: number, y: number, z: number, oldId: BlockId, newId: BlockId): boolean {
  if (isFluidId(oldId) || isFluidId(newId)) return true;
  // 垂直邻格必在同 chunk（越界返回 AIR），直接读
  if (isFluidId(world.getBlock(x, y - 1, z)) || isFluidId(world.getBlock(x, y + 1, z))) return true;
  for (const [dx, dz] of DIRS4) {
    if (!world.isChunkLoaded(x + dx, z + dz)) return true;
    if (isFluidId(world.getBlock(x + dx, y, z + dz))) return true;
  }
  return false;
}

export function fluidQueueSize(): number {
  let n = 0;
  for (const ys of pending.values()) n += ys.size;
  return n;
}

/** 清空流体队列与岩浆计时（切换世界时调用，防止旧坐标/旧累计带进新世界） */
export function clearFluids(): void {
  pending = new Map();
  created.clear();
  falling.clear();
  lavaAcc = 0;
}

/** 生成一格流水/流动岩浆并入队：标记为本拍新生，下一拍才参与扩散/消退结算；
 *  fall=true 时登记为下落流体（falling 集合是流体格 falling 状态的权威写入点） */
function spawnFlow(world: World, x: number, y: number, z: number, id: BlockId, fall = false): void {
  world.setBlock(x, y, z, id);
  if (fall) addCell(falling, x, y, z);
  else deleteCell(falling, x, y, z);
  addCell(created, x, y, z);
  addCell(pending, x, y, z);
}

const OBSIDIAN_ID = BLOCK_BY_KEY.obsidian.id;

/** 水冲毁一格的掉落（对齐挖掘规则，流体破坏无工具/精准采集概念；岩浆冲毁不掉落，MC） */
function spawnWashDrop(x: number, y: number, z: number, id: BlockId): void {
  const def = BLOCKS[id];
  if (!def) return;
  if (id >= WHEAT_CROP_0 && id <= WHEAT_CROP_0 + 7) {
    // 小麦：成熟掉 1 小麦 + 0-2 种子；未熟只掉 1 种子（同挖掘）
    if (id >= WHEAT_CROP_0 + 7) {
      spawnMaterialDrop('wheat', x + 0.5, y + 0.4, z + 0.5, 1);
      const seeds = Math.floor(Math.random() * 3);
      if (seeds > 0) spawnMaterialDrop('wheat_seeds', x + 0.5, y + 0.4, z + 0.5, seeds);
    } else {
      spawnMaterialDrop('wheat_seeds', x + 0.5, y + 0.4, z + 0.5, 1);
    }
    return;
  }
  if (def.drop) {
    // 材料掉落（地狱疣 1-2 个，同挖掘）
    const [min, max] = def.drop.count;
    spawnMaterialDrop(def.drop.material, x + 0.5, y + 0.4, z + 0.5, min + Math.floor(Math.random() * (max - min + 1)));
  } else if (id === BLOCK_BY_KEY.short_grass.id || id === BLOCK_BY_KEY.fern.id || id === BLOCK_BY_KEY.tall_grass.id || id === BLOCK_BY_KEY.large_fern.id) {
    // 草丛/蕨（底段）：25% 掉小麦种子（同挖掘）
    if (Math.random() < 0.25) spawnMaterialDrop('wheat_seeds', x + 0.5, y + 0.4, z + 0.5, 1);
  } else if (def.nonSilkDrop === 'nothing') {
    // MC：无掉落
  } else if (def.nonSilkDrop) {
    // 材料掉落（雪层 → 1 雪球，同挖掘非精准）
    const [min, max] = def.nonSilkDrop.count;
    spawnMaterialDrop(def.nonSilkDrop.material, x + 0.5, y + 0.4, z + 0.5, min + Math.floor(Math.random() * (max - min + 1)));
  } else {
    spawnBlockDrop(def.dropBlock ?? id, x + 0.5, y + 0.4, z + 0.5);
  }
}

/**
 * 流体冲毁一格非实心方块（目标格随后被 spawnFlow 占据）：
 * 联动清除双格高植物另一段与柱状植物（甘蔗）上方各节（同挖掘的联动规则）；
 * water=true 时按挖掘规则弹出掉落物（同爆炸/重力等物理路径，不限游戏模式），岩浆只销毁。
 */
function breakWashable(world: World, x: number, y: number, z: number, id: BlockId, water: boolean): void {
  const def = BLOCKS[id];
  if (def?.twoHigh && BLOCKS[world.getBlock(x, y + 1, z)]?.plantTop) world.setBlock(x, y + 1, z, AIR);
  if (def?.plantTop && BLOCKS[world.getBlock(x, y - 1, z)]?.twoHigh) world.setBlock(x, y - 1, z, AIR);
  if (isColumnPlantId(id)) {
    let cy = y + 1;
    while (isColumnPlantId(world.getBlock(x, cy, z))) {
      const aid = world.getBlock(x, cy, z);
      world.setBlock(x, cy, z, AIR);
      if (water) spawnBlockDrop(BLOCKS[aid].dropBlock ?? aid, x + 0.5, cy + 0.4, z + 0.5);
      cy++;
    }
  }
  if (water) spawnWashDrop(x, y, z, id);
}

/** 水格处理：水火接触反应 + 消退 + 无限水源 + 向下流 + 落地扩散 + 冲毁非实心方块 */
function tickWater(world: World, x: number, y: number, z: number, level: number): void {
  // 下落水（MC falling）：源/下落格垂直下流形成，强度等同源——落地从 1 级起扩满；不是源、不能转源
  let fall = hasCell(falling, x, y, z);
  if (fall && level !== 1) { deleteCell(falling, x, y, z); fall = false; } // 陈旧标记：格内容已非 1 级流
  // 水火接触（MC）：侧向邻居或正下方是岩浆源（含水从上方浇到源上）→ 一律黑曜石
  for (const [dx, dz] of DIRS4) {
    if (!world.isChunkLoaded(x + dx, z + dz)) continue;
    if (world.getBlock(x + dx, y, z + dz) === LAVA) world.setBlock(x + dx, y, z + dz, OBSIDIAN_ID);
  }
  if (world.getBlock(x, y - 1, z) === LAVA) world.setBlock(x, y - 1, z, OBSIDIAN_ID);
  // 混凝土粉末固化（MC：邻接水立即固化，含水流入格）：6 邻域的粉末变对应颜色混凝土
  for (const [dx, dy, dz] of DIRS6) {
    if (dy === 0 && !world.isChunkLoaded(x + dx, z + dz)) continue;
    const key = BLOCKS[world.getBlock(x + dx, y + dy, z + dz)]?.key;
    if (key?.endsWith('_concrete_powder')) world.setBlock(x + dx, y + dy, z + dz, BLOCK_BY_KEY[key.slice(0, -'_powder'.length)].id);
  }
  // 消退（仅流水）：上方供水 或 同级上游（level-1）邻居，缺失则退化为空气（MC 规则）；
  // falling 邻居按源强度（0 级）计——瀑布落地柱作为上游供养四周 1 级流（MC 瀑布成潭）
  if (level > 0 && !isWaterId(world.getBlock(x, y + 1, z))) {
    const parentLevel = level - 1;
    const hasParent = DIRS4.some(([dx, dz]) => {
      if (!world.isChunkLoaded(x + dx, z + dz)) return false;
      const nLevel = waterLevel(world.getBlock(x + dx, y, z + dz));
      // 同流体的 falling 格（必为 1 级流 id）视为 0 级上游
      return nLevel === parentLevel || (parentLevel === 0 && nLevel === 1 && hasCell(falling, x + dx, y, z + dz));
    });
    if (!hasParent) {
      world.setBlock(x, y, z, AIR);
      deleteCell(falling, x, y, z);
      return;
    }
  }
  // 无限水源（MC 规则）：水平两侧都是水源 且 下方是水源或实心方块 → 本格成源；下落水（falling）不转源（MC）
  if (level > 0 && !fall) {
    let sources = 0;
    for (const [dx, dz] of DIRS4) {
      if (!world.isChunkLoaded(x + dx, z + dz)) continue;
      if (world.getBlock(x + dx, y, z + dz) === WATER) sources++;
    }
    if (sources >= 2) {
      const below = world.getBlock(x, y - 1, z);
      if (below === WATER || BLOCKS[below]?.opaque) {
        world.setBlock(x, y, z, WATER);
        return;
      }
    }
  }
  if (y > 0) {
    const below = world.getBlock(x, y - 1, z);
    // 空气/可冲毁格：向下流。源与下落格下传 falling（强度不减）；普通流水下落等级不变（MC 下落不减级）
    if (below === AIR || WASHABLE.has(below)) {
      if (below !== AIR) breakWashable(world, x, y - 1, z, below, true);
      spawnFlow(world, x, y - 1, z, level === 0 ? FLOW_BASE : FLOW_BASE + level - 1, level === 0 || fall);
      return;
    }
    // 水向下流入岩浆（MC）：流动岩浆 → 圆石（源已在上方接触判定中变黑曜石）
    if (isLavaId(below)) {
      world.setBlock(x, y - 1, z, COBBLE);
      return;
    }
  }
  // 落地才向四方扩散（下方是非水实心/流体底托）；水柱中段不在半空散开（MC 瀑布观感）。
  // 下落水按源强度扩散（effLevel 0 → 1 级起，MC：瀑布落地扩满 7 格；修复前 1 级柱落地只扩 6 格）
  const effLevel = fall ? 0 : level;
  if (effLevel < 7 && !isWaterId(world.getBlock(x, y - 1, z))) {
    for (const [dx, dz] of DIRS4) {
      if (!world.isChunkLoaded(x + dx, z + dz)) continue;
      const t = world.getBlock(x + dx, y, z + dz);
      if (t === AIR || WASHABLE.has(t)) {
        if (t !== AIR) breakWashable(world, x + dx, y, z + dz, t, true);
        spawnFlow(world, x + dx, y, z + dz, FLOW_BASE + effLevel);
      } else if (isLavaId(t)) {
        // 水侧向流入岩浆（MC）：流动岩浆 → 圆石（源已在接触判定中变黑曜石）
        world.setBlock(x + dx, y, z + dz, COBBLE);
      }
    }
  }
}

/** 岩浆格处理（每 lavaInterval 秒一步）：水火接触 + 向下流 + 落地按维度距离扩散 + 烧毁非实心方块 */
function tickLava(world: World, x: number, y: number, z: number, level: number, maxLevel: number): void {
  // 下落岩浆（MC falling，与水同理）：源/下落格垂直下流形成，强度等同源——落地按维度从 1 级起扩满
  let fall = hasCell(falling, x, y, z);
  if (fall && level !== 1) { deleteCell(falling, x, y, z); fall = false; } // 陈旧标记：格内容已非 1 级流
  // 上方是水（MC：水从上方浇到岩浆）：源 → 黑曜石（源遇水一律黑曜石）；流动岩浆 → 圆石
  if (isWaterId(world.getBlock(x, y + 1, z))) {
    world.setBlock(x, y, z, level === 0 ? OBSIDIAN_ID : COBBLE);
    deleteCell(falling, x, y, z);
    return;
  }
  // 岩浆源遇侧向水 → 黑曜石（MC）
  if (level === 0) {
    const sideWater = DIRS4.some(
      ([dx, dz]) => world.isChunkLoaded(x + dx, z + dz) && isWaterId(world.getBlock(x + dx, y, z + dz)),
    );
    if (sideWater) {
      world.setBlock(x, y, z, OBSIDIAN_ID);
      return;
    }
  }
  // 消退（仅流动岩浆，MC：断源逐级枯竭）：上方无岩浆 且 无 level-1 上游邻居 → 退化为空气。
  // 消退发生在岩浆步里（主世界/末地 1.5s、下界 0.5s 一步），消退格 setBlock 会把下游邻居重新入队，
  // 下一级在下一个岩浆步才消退——节奏与扩散一致。
  if (level > 0 && !isLavaId(world.getBlock(x, y + 1, z))) {
    const parentLevel = level - 1;
    const hasParent = DIRS4.some(([dx, dz]) => {
      if (!world.isChunkLoaded(x + dx, z + dz)) return false;
      const nLevel = lavaLevel(world.getBlock(x + dx, y, z + dz));
      // 同流体的 falling 格（必为 1 级流 id）视为 0 级上游（与水同理：岩浆瀑布落地柱供养 1 级流）
      return nLevel === parentLevel || (parentLevel === 0 && nLevel === 1 && hasCell(falling, x + dx, y, z + dz));
    });
    if (!hasParent) {
      world.setBlock(x, y, z, AIR);
      deleteCell(falling, x, y, z);
      return;
    }
  }
  if (y > 0) {
    const below = world.getBlock(x, y - 1, z);
    // 空气/可冲毁格：向下流（岩浆烧毁不掉落，MC）。源与下落格下传 falling；流动等级不变（与水相同，下落直达）
    if (below === AIR || WASHABLE.has(below)) {
      if (below !== AIR) breakWashable(world, x, y - 1, z, below, false);
      spawnFlow(world, x, y - 1, z, level === 0 ? LAVA_FLOW_BASE : LAVA_FLOW_BASE + level - 1, level === 0 || fall);
      return;
    }
    // 岩浆向下流入水（MC）→ 石头
    if (isWaterId(below)) {
      world.setBlock(x, y - 1, z, STONE);
      return;
    }
  }
  // 落地才向四方扩散（下方非空非岩浆柱）；主世界/末地至多 3 级、下界至多 7 级。
  // 下落岩浆按源强度扩散（effLevel 0 → 1 级起，与水同理：岩浆瀑布落地扩满 3/7 格）
  const effLevel = fall ? 0 : level;
  if (effLevel < maxLevel && !isLavaId(world.getBlock(x, y - 1, z))) {
    for (const [dx, dz] of DIRS4) {
      if (!world.isChunkLoaded(x + dx, z + dz)) continue;
      const t = world.getBlock(x + dx, y, z + dz);
      if (t === AIR || WASHABLE.has(t)) {
        if (t !== AIR) breakWashable(world, x + dx, y, z + dz, t, false);
        spawnFlow(world, x + dx, y, z + dz, LAVA_FLOW_BASE + effLevel);
      } else if (isWaterId(t)) {
        // 侧向流入水的岩浆（MC）→ 圆石
        world.setBlock(x + dx, y, z + dz, COBBLE);
      }
    }
  }
}

/**
 * 每 ~0.4s（sim.ts 慢节奏一拍）调用一次：从队列取最多 budget 个流体格子尝试传播。
 * 水每拍结算（每拍前进一级，对齐 MC 每级 5 tick=0.25s 的量级）；岩浆按维度节奏结算
 * （主世界/末地 1.5s、下界 0.5s 一步），未到节奏的岩浆格留回队列。
 */
export function tickFluids(world: World, budget = 128): void {
  if (pending.size === 0) return;
  const nether = world.terrain.kind === 'nether';
  lavaAcc += BEAT;
  const lavaInterval = nether ? LAVA_INTERVAL_NETHER : LAVA_INTERVAL_NORMAL;
  const lavaDue = lavaAcc >= lavaInterval;
  if (lavaDue) lavaAcc -= lavaInterval;
  const maxLavaLevel = nether ? 7 : 3;
  // 本拍结算快照：O(1) 整体换出队列——只处理拍开始时已在队列的格子；拍内扩散/消退 setBlock
  // 新入队的格子落进新队列，留到下一拍（与原 [...pending] 数组快照同语义，免整队字符串分配）。
  // （MC 水每级 5 tick、岩浆每级 1.5s/下界 0.5s，每级都要等一个流动周期）
  const batch = pending;
  pending = new Map();
  created.clear();
  let drained = 0;
  let overBudget = false;
  for (const [col, ys] of batch) {
    const x = Math.floor(col / XZ_SPAN) - XZ_OFF;
    const z = col % XZ_SPAN - XZ_OFF;
    for (const y of ys) {
      // 预算耗尽：本格与剩余格子原样留回队列（与原 break 时留在 pending 的语义一致）
      if (overBudget || drained >= budget) {
        overBudget = true;
        addCell(pending, x, y, z);
        continue;
      }
      // 未加载的格子不处理——getBlock 会隐式触发全量生成，把 chunk 生成拖出渲染半径形成生成风暴
      if (!world.isChunkLoaded(x, z)) continue;
      const id = world.getBlock(x, y, z);
      const wLevel = waterLevel(id);
      const lLevel = wLevel < 0 ? lavaLevel(id) : -1;
      if (wLevel < 0 && lLevel < 0) {
        drained++; // 非流体（已被挖掉/替换）：出队即弃
        deleteCell(falling, x, y, z); // 顺手清掉可能残留的下落标记
        continue;
      }
      // 岩浆节奏未到：本拍不结算，留回队列（先查节奏再结算，节奏未到的岩浆格不做无效结算）
      if (lLevel >= 0 && !lavaDue) {
        addCell(pending, x, y, z);
        continue;
      }
      if (hasCell(created, x, y, z)) {
        addCell(pending, x, y, z); // 本拍内新生成的流体格：留到下一拍
        continue;
      }
      drained++;
      // 邻格同理：chunk 未加载的方向由 tickWater/tickLava 内逐向判 isChunkLoaded 跳过，
      // 否则在加载半径边缘倒液体会逐 chunk 向外爬，每步都隐式触发主线程全量地形生成 + cascadeLight
      if (wLevel >= 0) tickWater(world, x, y, z, wLevel);
      else tickLava(world, x, y, z, lLevel, maxLavaLevel);
    }
  }
}

// 世界作用域自注册（lib/worldScope.ts）：流体队列随世界清理
registerWorldScope({ name: 'fluids', clear: clearFluids });
