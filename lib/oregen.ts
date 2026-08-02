// 矿石/岩石团簇与基岩层生成：按 chunk 确定性播种，在石头/深板岩中植入矿脉
// 分布复刻 MC 1.21（按 WORLD_HEIGHT=128 缩放）：
// 煤 0-96 峰 48（山地增量）· 铁双峰（主峰 20 + 山地 80）· 铜峰 48 · 金 y<16（恶地 24-84 富矿）
// 青金石峰 20 · 红石 y<16 · 钻石 y<16 越深越多 · 绿宝石仅山地 y>40 · 深板岩带 y≤16

import { AIR, BLOCK_BY_KEY, BLOCKS } from './blocks';
import { hash2, mulberry32, SEA_LEVEL, type Biome, type Terrain } from './noise';
import { CHUNK_SIZE, WORLD_HEIGHT, localIndex } from './grid';

const STONE = BLOCK_BY_KEY.stone.id;
const DEEPSLATE = BLOCK_BY_KEY.deepslate.id;
const BEDROCK = BLOCK_BY_KEY.bedrock.id;

interface Vein {
  id: number;
  /** 深板岩宿主时的深层变体（缺省与 id 相同） */
  dsId?: number;
  /** 每 chunk 矿脉条数 [min, max] */
  count: [number, number];
  /** 单条矿脉方块数 [min, max] */
  size: [number, number];
  minY: number;
  maxY: number;
  /** triangle = 中段三角峰（峰在 (min+max)/2）；deep = 越深越多（偏向 minY）；缺省均匀 */
  shape?: 'triangle' | 'deep';
  /** 可替换的宿主方块（默认石头+深板岩） */
  hosts?: number[];
  /** 限定群系（缺省全群系） */
  only?: Biome[];
  /** Java discardChanceOnAirExposure：暴露于空气（6 邻有空气格）的矿块按此概率回退为母岩（缺省 0 = 不削减） */
  airDiscard?: number;
}

const KEY = (k: string) => BLOCK_BY_KEY[k].id;
const ORE = (k: string): Pick<Vein, 'id' | 'dsId'> => ({ id: KEY(k), dsId: KEY(`deepslate_${k}`) });

const VEINS: Vein[] = [
  // 岩石团簇（石头→各类石头/土/砾石/黏土）
  { id: KEY('dirt'), count: [4, 8], size: [8, 20], minY: 0, maxY: 110 },
  { id: KEY('gravel'), count: [3, 6], size: [6, 14], minY: 0, maxY: 110 },
  { id: KEY('granite'), count: [3, 6], size: [8, 16], minY: 0, maxY: 110 },
  { id: KEY('diorite'), count: [3, 6], size: [8, 16], minY: 0, maxY: 110 },
  { id: KEY('andesite'), count: [3, 6], size: [8, 16], minY: 0, maxY: 110 },
  { id: KEY('clay'), count: [1, 3], size: [4, 8], minY: 30, maxY: 44, hosts: [STONE, KEY('dirt'), KEY('sand')] },
  { id: KEY('tuff'), count: [1, 2], size: [6, 12], minY: 0, maxY: 24 },
  // 煤：0-96 三角峰 48（Java 下层煤为埋藏型，空气暴露丢弃率 0.5）；山地附加富集带（MC：山地煤明显增多，上层煤无削减）
  { ...ORE('coal_ore'), count: [10, 16], size: [4, 10], minY: 0, maxY: 96, shape: 'triangle', airDiscard: 0.5 },
  { ...ORE('coal_ore'), count: [4, 8], size: [4, 9], minY: 56, maxY: 110, only: ['mountains'] },
  // 铁：主峰 20（4-36 三角）+ 山地次峰 80（56-104 三角）；深层偶见粗铁块团（MC 大矿脉标志）
  { ...ORE('iron_ore'), count: [6, 10], size: [3, 7], minY: 4, maxY: 36, shape: 'triangle' },
  { ...ORE('iron_ore'), count: [4, 8], size: [3, 7], minY: 56, maxY: 104, shape: 'triangle', only: ['mountains'] },
  { id: KEY('raw_iron_block'), count: [0, 1], size: [2, 4], minY: 0, maxY: 16, hosts: [DEEPSLATE] },
  // 铜：8-72 三角峰 48
  { ...ORE('copper_ore'), count: [4, 7], size: [3, 8], minY: 24, maxY: 72, shape: 'triangle' },
  // 金：深层 y<16（埋藏型，暴露丢弃率 0.5）；恶地富矿带 24-84（MC 恶地淘金特性，露天金矿无削减）
  { ...ORE('gold_ore'), count: [1, 3], size: [2, 5], minY: 0, maxY: 16, airDiscard: 0.5 },
  { ...ORE('gold_ore'), count: [3, 6], size: [3, 7], minY: 24, maxY: 84, only: ['badlands'] },
  // 青金石：0-40 三角峰 20（埋藏型：绝不裸露，丢弃率 1.0）
  { ...ORE('lapis_ore'), count: [1, 2], size: [2, 4], minY: 0, maxY: 40, shape: 'triangle', airDiscard: 1.0 },
  // 红石：y<16
  { ...ORE('redstone_ore'), count: [2, 4], size: [3, 6], minY: 0, maxY: 16 },
  // 钻石：y<16 越深越多（埋藏型：绝不裸露，丢弃率 1.0）
  { ...ORE('diamond_ore'), count: [1, 3], size: [2, 5], minY: 0, maxY: 16, shape: 'deep', airDiscard: 1.0 },
  // 绿宝石：仅山地，y 40-110（MC 特性）
  { ...ORE('emerald_ore'), count: [1, 3], size: [1, 2], minY: 40, maxY: 110, only: ['mountains'] },
];

const randInt = (rand: () => number, [min, max]: [number, number]): number =>
  min + Math.floor(rand() * (max - min + 1));

/** 按分布形状取 y：三角峰 / 越深越多 / 均匀 */
function sampleY(rand: () => number, v: Vein): number {
  const span = v.maxY - v.minY + 1;
  if (v.shape === 'deep') return v.minY + Math.floor(rand() * rand() * span);
  if (v.shape === 'triangle') return v.minY + Math.floor(((rand() + rand()) / 2) * span);
  return v.minY + Math.floor(rand() * span);
}

/** 地形填充后调用：基岩层 + 深板岩渐变 + 团簇矿脉（全部按 chunk 坐标确定性） */
export function applyOres(seedHash: number, terrain: Terrain, cx: number, cz: number, data: Uint16Array): void {
  const rand = mulberry32(
    (seedHash ^ Math.imul(cx + 0x9e37, 0x85ebca6b) ^ Math.imul(cz + 0x27d4, 0x165667b1)) | 0,
  );

  // 列存在性：虚空列（heightAt < 0，如测试地形）不做任何填充
  const solid = (x: number, z: number) => terrain.heightAt(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z) >= 0;

  // 基岩：y=0 全铺，y=1 约 1/2，y=2 约 1/4（与原版的随机底床一致）
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      if (!solid(x, z)) continue;
      data[localIndex(x, 0, z)] = BEDROCK;
      if (rand() < 0.5) data[localIndex(x, 1, z)] = BEDROCK;
      if (rand() < 0.25) data[localIndex(x, 2, z)] = BEDROCK;
    }
  }

  // 深板岩带：y≤16，越往下越密，把石头渐变为深板岩
  for (let y = 0; y <= 16; y++) {
    const p = ((16 - y) / 16) * 0.75;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const i = localIndex(x, y, z);
        if (data[i] === STONE && rand() < p) data[i] = DEEPSLATE;
      }
    }
  }

  // 团簇矿脉：随机起点 + 随机游走成矿团；深板岩宿主放深层变体（MC 一致）
  for (const v of VEINS) {
    const hosts = v.hosts ?? [STONE, DEEPSLATE];
    const count = randInt(rand, v.count);
    for (let n = 0; n < count; n++) {
      let x = Math.floor(rand() * CHUNK_SIZE);
      let y = sampleY(rand, v);
      let z = Math.floor(rand() * CHUNK_SIZE);
      // 群系限定矿（绿宝石/山地煤铁/恶地金）：按矿脉起点所在列的群系判定
      if (v.only && !v.only.includes(terrain.biomeAt(cx * CHUNK_SIZE + x, cz * CHUNK_SIZE + z))) continue;
      const size = randInt(rand, v.size);
      for (let s = 0; s < size; s++) {
        if (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < WORLD_HEIGHT && z >= 0 && z < CHUNK_SIZE) {
          const i = localIndex(x, y, z);
          if (hosts.includes(data[i])) data[i] = data[i] === DEEPSLATE ? (v.dsId ?? v.id) : v.id;
        }
        x += Math.floor(rand() * 3) - 1;
        y += Math.floor(rand() * 3) - 1;
        z += Math.floor(rand() * 3) - 1;
      }
    }
  }
}

// 深层岩浆湖面高度（与 world.ts 的 LAVA_LAKE_TOP 保持一致；跨界邻格推断空气时用）
const LAVA_LAKE_TOP = 10;

/** 带空气暴露削减的矿块 id → 丢弃概率（普通与深层变体同率） */
const AIR_DISCARD: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  for (const v of VEINS) {
    if (!v.airDiscard) continue;
    m.set(v.id, v.airDiscard);
    if (v.dsId) m.set(v.dsId, v.airDiscard);
  }
  return m;
})();

/**
 * 洞穴雕刻与灌水/岩浆完成后调用：暴露于空气（6 邻有空气格）的埋藏型矿块按概率回退为母岩
 * （Java discardChanceOnAirExposure：钻石/青金石 1.0 绝不裸露，深层金/下层煤 0.5）。
 * 只认空气格——被水/岩浆填充的洞腔不算暴露（Java 一致）。
 * 跨界邻格不读邻 chunk（生成期触发邻 chunk 隐式生成会链式扩散），与甘蔗/仙人掌一致按地形推断：
 * 该格被洞穴雕空且不在灌水/岩浆填充带内即视为空气。
 */
export function applyAirExposure(seedHash: number, terrain: Terrain, cx: number, cz: number, data: Uint16Array): void {
  if (AIR_DISCARD.size === 0) return;
  // 跨界邻格是否空气（仅水平向可能出界；垂直向必在本 chunk 内）
  const neighborAir = (wx: number, wz: number, nx: number, y: number, nz: number): boolean => {
    const nh = terrain.heightAt(nx, nz);
    if (nh < 0 || y < 4 || y > nh) return false; // 洞穴雕刻范围 y∈[4,h]
    if (!terrain.caveAt(nx, y, nz, nh)) return false;
    if (nh < SEA_LEVEL && y <= SEA_LEVEL) return false; // 海底洞穴灌水（world.ts 海平面以下洞腔回填水）
    if (terrain.aquiferAt(nx, nz) && y >= 5 && y <= Math.min(nh - 4, SEA_LEVEL - 2)) return false; // 地下含水层
    if (y <= LAVA_LAKE_TOP) return false; // 深层岩浆湖
    return true;
  };
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const i = localIndex(x, y, z);
        const id = data[i];
        const p = AIR_DISCARD.get(id);
        if (p === undefined) continue;
        let exposed = false;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
          const ly = y + dy;
          if (ly < 0 || ly >= WORLD_HEIGHT) continue;
          const lx = x + dx;
          const lz = z + dz;
          if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
            if (data[localIndex(lx, ly, lz)] === AIR) {
              exposed = true;
              break;
            }
          } else if (neighborAir(wx, wz, wx + dx, ly, wz + dz)) {
            exposed = true;
            break;
          }
        }
        // 按格坐标确定性掷点（与洞穴雕刻一致的盐混合模式）
        if (exposed && hash2(seedHash ^ Math.imul(y, 0x9e3779b9), wx, wz) < p) {
          data[i] = BLOCKS[id]?.key.startsWith('deepslate_') ? DEEPSLATE : STONE;
        }
      }
    }
  }
}
