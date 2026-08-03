// 地形生成纯管线：从 world.ts 抽出的叶子模块，主线程（同步兜底）与生成 Worker 共用同一份实现，
// 保证两条路径逐格一致。依赖链只含 blocks/biomes/noise/oregen/geodes/structures/stronghold/trees/
// nether/end/storage（无 react/store/idb/three），可安全打包进 Web Worker（同 grid.ts 的约束注释）。

import { AIR, BLOCK_BY_KEY, BLOCKS, LAVA, STONE, WATER } from './blocks';
import { BADLANDS_BANDS, BIOME_SURFACE } from './biomes';
import { createTerrain, hash2, hashString, mulberry32, SEA_LEVEL, type Biome, type Terrain } from './noise';
import { createNetherTerrain, generateNetherChunk } from './nether';
import { createEndTerrain, generateEndChunk } from './end';
import { applyAirExposure, applyOres } from './oregen';
import { applyGeodes } from './geodes';
import { applyStructures } from './structures';
import { applyStronghold } from './stronghold';
import { HUGE_MUSHROOM_MAX_H, TREE_MAX_H, writeHugeMushroom, writeTree } from './trees';
import { clearStorages, storages } from './storage';
import type { Slot } from './slots';
import { CHUNK_SIZE, WORLD_HEIGHT, localIndex } from './grid';

/** 树形/巨蘑菇最大外扩格数（金合欢斜干 1 + 5×5 冠 2；巨蘑菇伞盖 2），跨 chunk 一致所需的环宽 */
const TREE_RING = 3;

/** 用地形填充 chunk（确定性的；树木含 ±TREE_RING 格边缘以跨 chunk 一致）；seedHash 用于村庄结构 */
export function generateChunk(terrain: Terrain, cx: number, cz: number, data: Uint16Array, seedHash = 0): void {
  // 列高度/群系缓存：同一列在地形填充、洞穴、灌水、树木、植被多轮中反复查询，每列只算一次。
  // 缓存覆盖树木环 ±TREE_RING 共 (16+2·TREE_RING)² 列（chunk 内 16×16 是其中子集）
  const RING = CHUNK_SIZE + TREE_RING * 2;
  const hCache = new Int16Array(RING * RING).fill(-2); // -2 = 未算过（heightAt 只会返回 -1 或 ≥1）
  const bCache: (Biome | undefined)[] = new Array(RING * RING);
  const ringIndex = (wx: number, wz: number) => (wx - cx * CHUNK_SIZE + TREE_RING) * RING + (wz - cz * CHUNK_SIZE + TREE_RING);
  const cachedHeightAt = (wx: number, wz: number): number => {
    const i = ringIndex(wx, wz);
    let h = hCache[i];
    if (h === -2) {
      h = terrain.heightAt(wx, wz);
      hCache[i] = h;
    }
    return h;
  };
  const cachedBiomeAt = (wx: number, wz: number): Biome => {
    const i = ringIndex(wx, wz);
    return (bCache[i] ??= terrain.biomeAt(wx, wz));
  };
  const K = (key: string) => BLOCK_BY_KEY[key].id;
  const SNOW_BLOCK = K('snow_block');
  const GRASS = K('grass');
  const DIRT = K('dirt');
  const SAND = K('sand');
  const GRAVEL = K('gravel');
  const PODZOL = K('podzol');
  const MYCELIUM = K('mycelium');
  const RED_SAND = K('red_sand');

  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      const h = cachedHeightAt(wx, wz);
      if (h < 0) continue;
      const biome = cachedBiomeAt(wx, wz);
      const surface = BIOME_SURFACE[biome];
      const top = Math.min(h, WORLD_HEIGHT - 1);
      // 群系表层微调：山地按雪线分带（山麓草石 → 裸岩 → 积雪），针叶林灰化土斑块
      let topBlock = surface.top;
      let fillerBlock = surface.filler;
      if (biome === 'mountains') {
        const sl = terrain.snowlineAt(wx, wz);
        if (top >= sl) {
          topBlock = SNOW_BLOCK;
          fillerBlock = STONE;
        } else if (top >= sl - 6) {
          topBlock = STONE;
          fillerBlock = STONE;
        } else {
          topBlock = hash2(seedHash ^ 0x3f7a11, wx, wz) < 0.3 ? GRAVEL : GRASS;
          fillerBlock = DIRT;
        }
      } else if (biome === 'taiga' && hash2(seedHash ^ 0x9d2b4c, wx, wz) < 0.35) {
        topBlock = PODZOL;
      }
      const beach = top <= SEA_LEVEL + 1;
      // 恶地陶瓦地层：列级色带偏移（MC 侵蚀恶地的彩色地层）
      const bandOff = biome === 'badlands' ? Math.floor(hash2(seedHash ^ 0x6b1e7a, wx, wz) * BADLANDS_BANDS.length * 3) : 0;
      for (let y = 0; y <= top; y++) {
        let id: number = STONE;
        if (y === top) id = beach ? (surface.beach ?? topBlock) : topBlock;
        else if (y >= top - 3) id = fillerBlock;
        else if (biome === 'badlands' && y >= top - 32) {
          id = BADLANDS_BANDS[Math.abs(Math.floor((y + bandOff) / 3)) % BADLANDS_BANDS.length];
        }
        data[localIndex(x, y, z)] = id;
      }
      // 水下地表：海床/河床换成群系的水下组成（顶两格，按列哈希取材质）
      if (top < SEA_LEVEL) {
        const pick = surface.underwater[Math.floor(hash2(seedHash, wx, wz) * surface.underwater.length)];
        data[localIndex(x, top, z)] = pick;
        if (top - 1 >= 0) data[localIndex(x, top - 1, z)] = pick;
      }
      // 水面：寒带封冻为冰，其余为水
      for (let y = top + 1; y <= SEA_LEVEL; y++) {
        data[localIndex(x, y, z)] = y === SEA_LEVEL && surface.waterTop ? surface.waterTop : WATER;
      }
    }
  }
  // 基岩层 + 深板岩渐变 + 团簇矿脉（地形填充后、树木/村庄前）
  applyOres(seedHash, terrain, cx, cz, data);
  // 紫水晶洞：三层球壳（须在洞穴雕刻前，洞穴可自然破开晶洞）
  applyGeodes(seedHash, terrain, cx, cz, data);
  // 洞穴雕刻（3D 噪声：意面隧道 + 奶酪洞腔；矿石填完后刻空，洞壁即现矿脉）
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      const h = cachedHeightAt(wx, wz);
      if (h < 0) continue;
      for (let y = 4; y <= h; y++) {
        if (terrain.caveAt(wx, y, wz, h)) data[localIndex(x, y, z)] = AIR;
      }
    }
  }
  // 海底洞穴灌水：海平面以下被雕空的洞腔，上方是水的向下灌满（MC 含水层观感，避免出现水下黑色气穴）
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      const h = cachedHeightAt(wx, wz);
      if (h < 0 || h >= SEA_LEVEL) continue;
      for (let y = SEA_LEVEL; y >= 4; y--) {
        const i = localIndex(x, y, z);
        if (data[i] === AIR && data[localIndex(x, y + 1, z)] === WATER) data[i] = WATER;
      }
    }
  }
  // 地下含水层：含水层区海平面以下的深洞灌水（MC 1.18 水帘洞；不破地表的洞才灌）
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      if (!terrain.aquiferAt(wx, wz)) continue;
      const h = cachedHeightAt(wx, wz);
      if (h < 0) continue;
      for (let y = Math.min(h - 4, SEA_LEVEL - 2); y >= 5; y--) {
        const i = localIndex(x, y, z);
        if (data[i] === AIR) data[i] = WATER;
      }
    }
  }
  // 深层岩浆湖：y≤10 的雕空洞腔自底向上灌岩浆（下方非空非水才灌，形成平整湖面）
  const LAVA_LAKE_TOP = 10;
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let y = 2; y <= LAVA_LAKE_TOP; y++) {
        const i = localIndex(x, y, z);
        if (data[i] !== AIR) continue;
        const below = data[localIndex(x, y - 1, z)];
        if (below !== AIR && below !== WATER) data[i] = LAVA;
      }
    }
  }
  // 矿石空气暴露削减（Java discardChanceOnAirExposure）：洞壁上裸露的埋藏型矿（下层煤/深层金/钻石/青金石）
  // 按概率回退为母岩。须在洞穴雕刻与灌水/岩浆之后（只认空气格，水/岩浆填充的洞腔不算暴露），且在
  // 洞穴群系装饰之前（装饰只填空气格与地表地板，不影响矿格邻接关系）
  applyAirExposure(seedHash, terrain, cx, cz, data);
  // 洞穴群系装饰（滴水石洞/繁茂洞穴）：洞地板铺滴水石/苔藓并立笋或杜鹃，洞顶倒挂钟乳/洞穴藤蔓
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      const zone = terrain.undergroundAt(wx, wz);
      if (!zone) continue;
      const h = cachedHeightAt(wx, wz);
      if (h < 0) continue;
      const yMax = Math.min(h - 4, WORLD_HEIGHT - 2); // 只装饰够深的洞，不动地表坑洼
      for (let y = 5; y <= yMax; y++) {
        const i = localIndex(x, y, z);
        if (data[i] !== AIR) continue;
        const below = data[localIndex(x, y - 1, z)];
        const above = data[localIndex(x, y + 1, z)];
        const r = hash2(seedHash ^ Math.imul(y, 0x9e3779b9), wx, wz);
        if (BLOCKS[below]?.opaque) {
          if (zone === 'dripstone') {
            if (r < 0.3) data[localIndex(x, y - 1, z)] = K('dripstone_block');
            else if (r < 0.42) {
              data[localIndex(x, y - 1, z)] = K('dripstone_block');
              data[i] = K('pointed_dripstone');
            }
          } else {
            if (r < 0.35) data[localIndex(x, y - 1, z)] = K('moss_block');
            else if (r < 0.45) {
              data[localIndex(x, y - 1, z)] = K('moss_block');
              data[i] = r < 0.42 ? K('azalea') : K('flowering_azalea');
            }
          }
        } else if (BLOCKS[above]?.opaque) {
          if (zone === 'dripstone') {
            if (r < 0.1) data[i] = K('pointed_dripstone_down');
          } else if (r < 0.08) data[i] = K('cave_vines');
        }
      }
    }
  }
  // 树木与巨蘑菇：检查本 chunk 及周围 TREE_RING 格内的列，只写入落在本 chunk 的部分（跨 chunk 一致）
  const put = (lx: number, y: number, lz: number, id: number, onlyAir: boolean) => {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
    const i = localIndex(lx, y, lz);
    if (onlyAir && data[i] !== AIR) return;
    data[i] = id;
  };
  for (let tx = -TREE_RING; tx < CHUNK_SIZE + TREE_RING; tx++) {
    for (let tz = -TREE_RING; tz < CHUNK_SIZE + TREE_RING; tz++) {
      const wx = cx * CHUNK_SIZE + tx;
      const wz = cz * CHUNK_SIZE + tz;
      const h = cachedHeightAt(wx, wz);
      if (h <= SEA_LEVEL + 1 || h >= WORLD_HEIGHT - 2) continue;
      const rand = mulberry32((seedHash ^ Math.imul(wx, 374761393) ^ Math.imul(wz, 668265263) ^ 0x7ee5) | 0);
      const kind = terrain.treeAt(wx, wz);
      if (kind) {
        if (h + TREE_MAX_H[kind] >= WORLD_HEIGHT) continue;
        // 丛林树自带垂藤（trees.ts）；沼泽橡树按群系加垂藤
        writeTree(put, kind, tx, h, tz, rand, { vines: cachedBiomeAt(wx, wz) === 'swamp' });
        continue;
      }
      const biome = cachedBiomeAt(wx, wz);
      // 冰刺：冰刺平原标志（浮冰高柱，偶带蓝冰基座）
      if (biome === 'ice_spikes') {
        if (rand() < 0.02 && h + 20 < WORLD_HEIGHT) {
          const H = 8 + Math.floor(rand() * 11); // 8-18
          const packed = K('packed_ice');
          for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            put(tx + dx, h + 1, tz + dz, packed, true);
            put(tx + dx, h + 2, tz + dz, packed, true);
          }
          for (let y = h + 3; y <= h + H; y++) put(tx, y, tz, packed, true);
          if (rand() < 0.5) {
            for (let dx = -1; dx <= 1; dx++) {
              for (let dz = -1; dz <= 1; dz++) {
                if (rand() < 0.6) put(tx + dx, h, tz + dz, K('blue_ice'), false);
              }
            }
          }
        }
        continue;
      }
      // 巨蘑菇：蘑菇岛成群、黑森林偶见（红/棕各半）
      const r = rand();
      const chance = biome === 'mushroom_fields' ? 0.03 : biome === 'dark_forest' ? 0.006 : 0;
      if (chance > 0 && r < chance && h + HUGE_MUSHROOM_MAX_H < WORLD_HEIGHT) {
        writeHugeMushroom(put, rand() < 0.5, tx, h, tz, rand);
      }
    }
  }
  // 村庄结构（确定性，跨 chunk 一致）
  applyStructures(seedHash, terrain, cx, cz, data);
  // 要塞（地下石砖结构 + 末地门房间；同样确定性，仅与要塞范围相交的 chunk 有写入）
  applyStronghold(seedHash, cx, cz, data);

  // 植被：按群系撒花草/仙人掌/甘蔗/蘑菇/睡莲/瓜果（只有支撑且上方为空才放）
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const wx = cx * CHUNK_SIZE + x;
      const wz = cz * CHUNK_SIZE + z;
      const biome = cachedBiomeAt(wx, wz);
      const h = cachedHeightAt(wx, wz);
      if (h < 0) continue;
      const surf = data[localIndex(x, h, z)];
      // 睡莲：仅沼泽未封冻的水面（Java 睡莲为沼泽特产；浮在水面之上的空气格）
      if (h < SEA_LEVEL) {
        if (
          biome === 'swamp' &&
          data[localIndex(x, SEA_LEVEL, z)] === WATER &&
          data[localIndex(x, SEA_LEVEL + 1, z)] === AIR &&
          hash2(seedHash ^ 0x1e7b3d, wx, wz) < 0.08
        ) {
          data[localIndex(x, SEA_LEVEL + 1, z)] = K('lily_pad');
        }
        continue;
      }
      if (h < SEA_LEVEL || h + 1 >= WORLD_HEIGHT) continue;
      const aboveI = localIndex(x, h + 1, z);
      if (data[aboveI] !== AIR) continue;
      // 甘蔗：岸线（脚下即海平面）四邻同高有水，宿主为草/土/沙/灰化土/菌丝（MC 一致）
      if (h === SEA_LEVEL && (surf === GRASS || surf === DIRT || surf === SAND || surf === PODZOL || surf === MYCELIUM)) {
        // 邻格是否有水：chunk 内直接读数据；跨界邻格不能读（生成期触发邻 chunk 隐式生成会链式扩散），
        // 按地形推断——邻列低于海平面且水面未封冻，同高格即是水（消除 chunk 边界的规则空缺线）
        const waterBeside = (dx: number, dz: number): boolean => {
          const lx = x + dx;
          const lz = z + dz;
          if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) return data[localIndex(lx, h, lz)] === WATER;
          const nh = cachedHeightAt(wx + dx, wz + dz);
          return nh >= 0 && nh < SEA_LEVEL && !BIOME_SURFACE[cachedBiomeAt(wx + dx, wz + dz)].waterTop;
        };
        const nearWater = waterBeside(1, 0) || waterBeside(-1, 0) || waterBeside(0, 1) || waterBeside(0, -1);
        if (nearWater && hash2(seedHash ^ 0xca3e11, wx, wz) < 0.3) {
          const ch = 1 + Math.floor(hash2(seedHash ^ 0xca3f22, wx, wz) * 3);
          for (let i = 0; i < ch && h + 1 + i < WORLD_HEIGHT; i++) data[localIndex(x, h + 1 + i, z)] = K('sugar_cane');
          continue;
        }
      }
      const r = hash2(seedHash ^ 0x51ab3f, wx, wz);
      const pick = hash2(seedHash ^ 0x7c91e2, wx, wz);
      switch (biome) {
        case 'plains':
        case 'basin': {
          if (surf !== GRASS) break;
          if (r < 1 / 256) {
            data[aboveI] = K('pumpkin');
            break;
          }
          // 高草丛（双格，MC 平原点缀）
          if (r < 0.003 && h + 2 < WORLD_HEIGHT && data[localIndex(x, h + 2, z)] === AIR) {
            data[aboveI] = K('tall_grass');
            data[localIndex(x, h + 2, z)] = K('tall_grass_top');
            break;
          }
          if (r >= 0.012) break;
          data[aboveI] =
            pick < 0.45 ? K('short_grass') : pick < 0.6 ? K('dandelion') : pick < 0.75 ? K('poppy') : pick < 0.85 ? K('cornflower') : pick < 0.95 ? K('oxeye_daisy') : K('allium');
          break;
        }
        case 'forest':
        case 'birch_forest': {
          if (surf !== GRASS || r >= 0.02) break;
          // Java 蓝兰花仅沼泽生成，森林不出；末位用滨菊（Java 森林常见花）
          data[aboveI] =
            pick < 0.5 ? K('fern') : pick < 0.65 ? K('short_grass') : pick < 0.8 ? K('poppy') : pick < 0.9 ? K('dandelion') : K('oxeye_daisy');
          break;
        }
        case 'taiga': {
          if (surf !== GRASS && surf !== PODZOL) break;
          if (r >= 0.05) break;
          // 大型蕨（双格，针叶林标志）
          if (pick < 0.2 && h + 2 < WORLD_HEIGHT && data[localIndex(x, h + 2, z)] === AIR) {
            data[aboveI] = K('large_fern');
            data[localIndex(x, h + 2, z)] = K('large_fern_top');
            break;
          }
          data[aboveI] = pick < 0.5 ? K('fern') : pick < 0.75 ? K('short_grass') : pick < 0.9 ? K('poppy') : K('brown_mushroom');
          break;
        }
        case 'snowy':
        case 'ice_spikes': {
          // 雪层覆盖（MC 雪原招牌）
          if (hash2(seedHash ^ 0x5e11a2, wx, wz) < 0.65) data[aboveI] = K('snow_layer');
          break;
        }
        case 'mountains': {
          // 雪顶之上再覆薄雪层，峰面更有层次
          if (surf === SNOW_BLOCK && hash2(seedHash ^ 0x5e11b3, wx, wz) < 0.4) data[aboveI] = K('snow_layer');
          break;
        }
        case 'dark_forest': {
          if (surf !== GRASS || r >= 0.03) break;
          data[aboveI] = pick < 0.3 ? K('fern') : pick < 0.65 ? K('red_mushroom') : K('brown_mushroom');
          break;
        }
        case 'desert': {
          if (surf !== SAND) break;
          if (r < 0.02) {
            // 仙人掌：四邻同高须为空（MC 贴墙不长），高 1-3
            // 跨界邻格同样按地形推断：邻列地表不高于本列，同高侧格即是空（消除边界规则空缺线）
            const airBeside = (dx: number, dz: number): boolean => {
              const lx = x + dx;
              const lz = z + dz;
              if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) return data[localIndex(lx, h + 1, lz)] === AIR;
              return cachedHeightAt(wx + dx, wz + dz) <= h;
            };
            const clear = airBeside(1, 0) && airBeside(-1, 0) && airBeside(0, 1) && airBeside(0, -1);
            if (!clear) break;
            const ch = 1 + Math.floor(pick * 3);
            for (let i = 0; i < ch && h + 1 + i < WORLD_HEIGHT; i++) data[localIndex(x, h + 1 + i, z)] = K('cactus');
          } else if (r < 0.05) {
            data[aboveI] = K('dead_bush');
          }
          break;
        }
        case 'savanna': {
          if (surf !== GRASS || r >= 0.2) break;
          // 高草丛（双格，热带草原标志；与短草混生）
          if (pick < 0.3 && h + 2 < WORLD_HEIGHT && data[localIndex(x, h + 2, z)] === AIR) {
            data[aboveI] = K('tall_grass');
            data[localIndex(x, h + 2, z)] = K('tall_grass_top');
            break;
          }
          data[aboveI] = pick < 0.8 ? K('short_grass') : K('dandelion');
          break;
        }
        case 'jungle': {
          if (surf !== GRASS) break;
          // 竹子成丛（茎段 + 带叶顶段，高 3-6）
          if (r < 0.02 && h + 7 < WORLD_HEIGHT) {
            const bh = 3 + Math.floor(pick * 4);
            let ok = true;
            for (let i = 1; i <= bh; i++) if (data[localIndex(x, h + i, z)] !== AIR) { ok = false; break; }
            if (ok) {
              for (let i = 1; i < bh; i++) data[localIndex(x, h + i, z)] = K('bamboo');
              data[localIndex(x, h + bh, z)] = K('bamboo_top');
            }
            break;
          }
          if (r >= 0.06) break;
          data[aboveI] = pick < 0.05 ? K('melon') : pick < 0.5 ? K('fern') : K('short_grass');
          break;
        }
        case 'swamp': {
          if (surf !== GRASS || r >= 0.05) break;
          data[aboveI] = pick < 0.3 ? K('blue_orchid') : pick < 0.6 ? K('short_grass') : pick < 0.85 ? K('fern') : K('brown_mushroom');
          break;
        }
        case 'badlands': {
          if (surf !== RED_SAND && !BLOCKS[surf]?.key.endsWith('terracotta')) break;
          if (r < 0.025) data[aboveI] = K('dead_bush');
          break;
        }
        case 'mushroom_fields': {
          if (surf !== MYCELIUM || r >= 0.03) break;
          data[aboveI] = pick < 0.5 ? K('red_mushroom') : K('brown_mushroom');
          break;
        }
        default:
          break; // snowy / mountains / ocean / river 无地表植被
      }
    }
  }
}

/** 维度（与 Terrain.kind 对应；缺省主世界） */
export type DimKind = 'overworld' | 'nether' | 'end';

/** 生成期登记的结构战利品：[位置 key "x,y,z", 27 格内容]（fillChest 写入全局 storages 的镜像，
 *  worker 生成时随响应回传，主线程落地时按 fillChest 幂等语义并回） */
export type ChestLoot = [pos: string, slots: (Slot | null)[]];

// 维度地形缓存：worker 连续生成同世界的 chunk 时复用地形实例（建一次约 1ms 的噪声场开销只付一次）。
// 多世界/维度切换时按 key 区分；容量有限防泄漏（正常只有一个活跃世界）
const terrainCache = new Map<string, Terrain>();

/** 按种子与维度重建确定性地形（与 World 构造/makeDimWorld 的种子约定一致：下界/末地种子调用方已加后缀） */
export function getDimTerrain(seed: string, kind: DimKind): Terrain {
  const k = `${kind}:${seed}`;
  let t = terrainCache.get(k);
  if (!t) {
    t = kind === 'nether' ? createNetherTerrain(seed) : kind === 'end' ? createEndTerrain(seed) : createTerrain(seed);
    if (terrainCache.size >= 4) terrainCache.clear();
    terrainCache.set(k, t);
  }
  return t;
}

/**
 * 生成一个 chunk 的方块数据（主/worker 共用同一管线，保证逐格一致）。
 * 返回生成期登记的结构战利品（fillChest 的全局副作用在 worker 里无法直达主线程，随结果回传）。
 * 注意：会清空本线程的 storages 全局表——只在生成 Worker（或测试的隔离流程）里调用；
 * 主线程同步路径仍走 World.getChunk 的原生分发（不经过本函数），其 fillChest 副作用不变。
 */
export function generateChunkData(seed: string, kind: DimKind, cx: number, cz: number, data: Uint16Array): ChestLoot[] {
  const terrain = getDimTerrain(seed, kind);
  const seedHash = hashString(seed);
  clearStorages();
  try {
    if (terrain.kind === 'nether') generateNetherChunk(terrain, cx, cz, data, seedHash);
    else if (terrain.kind === 'end') generateEndChunk(terrain, cx, cz, data, seedHash);
    else generateChunk(terrain, cx, cz, data, seedHash);
    const chests: ChestLoot[] = [];
    for (const [pos, slots] of storages) {
      // 只回传有内容的登记（fillChest 全 roll 失败的空登记无意义；幂等合并语义也只认非空）
      if (slots.some((s) => s !== null)) chests.push([pos, [...slots]]);
    }
    return chests;
  } finally {
    clearStorages();
  }
}
