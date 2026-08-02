// 爆炸共享逻辑：TNT 与苦力怕共用（逐方块爆炸抗性 + 射线衰减破块 + 水下吸能 + 遮挡伤害 + 弹射已点燃 TNT + 粒子 + 音效）

import { AIR, BLOCKS, BLOCK_BY_KEY, FURNACE, blastResistanceOf, isLavaId, isWaterId, tileOf } from './blocks';
import { dropFurnaceContents } from './furnace';
import { checkGravityAt } from './gravity';
import { breakParticles, addShake } from './game';
import { spawnBlockDrop, spawnMaterialDrop } from './items';
import { boom, playSound } from './sound';
import { dropStorageContents } from './storage';
import { useGameStore } from './store';
import { igniteTnt, primedTnt } from './tnt';
import type { World } from './world';

export interface ExplodeOptions {
  /** 爆炸半径（TNT 4，苦力怕 3） */
  radius: number;
  /** 玩家最大伤害（贴脸），随距离线性衰减 × 遮挡率（隔墙≈0，MC） */
  maxDamage: number;
  /** 伤害判定半径 */
  hurtRadius: number;
  /** TNT 爆炸：被破坏方块 100% 掉落（MC 1.14+）；缺省按 1/radius 概率掉落（苦力怕/恶魂/凋灵） */
  tnt?: boolean;
}

/**
 * 爆心→目标格途经方块的抗性总和（不含目标格自身；对齐 Java Explosion 的射线衰减）。
 * Java 从爆心向单位立方体表面 16×16×6 个网格点各发一条射线、按 0.3 步进逐格扣强度；
 * 这里简化为「每格一条直线 + 0.3 步进采样」（爆炸频次低，性能预算内，趋势一致：
 * 抗性越高的墙衰减越多，防爆方块直接吞掉整条射线护住后方）。途经的流体格不衰减、流体自身免疫爆炸
 * （旧语义保持）；但爆心浸在水/岩浆中时整条射线按 Java 流体爆炸抗性 100 吸能 → 水下 TNT 基本不破块
 * （伤害照常结算，见 explosionExposure 路径，与 Java 一致）。
 */
function pathAbsorption(world: World, x: number, y: number, z: number, bx: number, by: number, bz: number): number {
  const dx = bx + 0.5 - x;
  const dy = by + 0.5 - y;
  const dz = bz + 0.5 - z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist === 0) return 0;
  const ux = dx / dist;
  const uy = dy / dist;
  const uz = dz / dist;
  // Java 水/岩浆爆炸抗性 100：爆心浸入流体时吸能足以吞掉全部射线（爆心在空气中则不加，避免过度防护水下方块）
  const origin = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  let sum = isWaterId(origin) || isLavaId(origin) ? 100 : 0;
  // 采样到目标格边界为止（回溯半格，避免把目标格自身算进途经；目标格抗性由调用方单独计入）
  for (let s = 0.3; s < dist - 0.5; s += 0.3) {
    const id = world.getBlock(Math.floor(x + ux * s), Math.floor(y + uy * s), Math.floor(z + uz * s));
    if (id === AIR || isWaterId(id) || isLavaId(id)) continue;
    const res = blastResistanceOf(id);
    if (res === Infinity) return Infinity; // 黑曜石墙/基岩吞掉射线，其后方块全部幸免（MC）
    sum += res;
  }
  return sum;
}

/**
 * 爆炸遮挡率（对齐 Java Explosion.getSeenPercent）：从爆心向实体包围盒网格点发射线，
 * 被实心方块挡住的计不可见，返回可见比例（完全遮挡 ≈ 0 → 隔墙免伤）。
 * Java 按 0.3 间距在包围盒上铺数百个采样点；这里简化为 2×4×2 = 16 条盒内网格射线
 * （爆炸频次低、每条约数十步采样，性能预算内；实心判定含玻璃，同 Java COLLIDER 射线）。
 */
export function explosionExposure(world: World, x: number, y: number, z: number, pos: { x: number; y: number; z: number }): number {
  // 玩家包围盒 0.6×1.8×0.6（pos 为脚底）
  const FX = [0.15, 0.85];
  const FY = [0.05, 0.35, 0.65, 0.95];
  const FZ = [0.15, 0.85];
  let visible = 0;
  for (const fx of FX) {
    for (const fy of FY) {
      for (const fz of FZ) {
        const tx = pos.x - 0.3 + 0.6 * fx;
        const ty = pos.y + 1.8 * fy;
        const tz = pos.z - 0.3 + 0.6 * fz;
        const dx = tx - x;
        const dy = ty - y;
        const dz = tz - z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist === 0) {
          visible++;
          continue;
        }
        let blocked = false;
        for (let s = 0.25; s < dist; s += 0.25) {
          const def = BLOCKS[world.getBlock(Math.floor(x + (dx / dist) * s), Math.floor(y + (dy / dist) * s), Math.floor(z + (dz / dist) * s))];
          if (def?.solid) {
            blocked = true;
            break;
          }
        }
        if (!blocked) visible++;
      }
    }
  }
  return visible / (FX.length * FY.length * FZ.length);
}

/**
 * 在 (x,y,z) 爆炸：半径内概率破坏方块（中心全碎，边缘渐稀；途经方块与自身抗性折成等效距离衰减概率，
 * 抗性够高的方块挡住爆炸且自身不毁——圆石墙显著优于泥土墙、铁砧/黑曜石免疫），防爆方块除外，按距离×遮挡伤玩家
 */
export function explodeAt(
  world: World,
  x: number,
  y: number,
  z: number,
  playerPos: { x: number; y: number; z: number },
  onAttackPlayer: (damage: number) => void,
  opts: ExplodeOptions,
): void {
  const { radius: R, maxDamage, hurtRadius } = opts;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const cz = Math.floor(z);
  const strength = R + 2; // 爆心强度（与旧 1-d/(R+2) 同尺度：中心必碎、边缘渐稀）
  for (let bx = cx - R; bx <= cx + R; bx++) {
    for (let by = cy - R; by <= cy + R; by++) {
      for (let bz = cz - R; bz <= cz + R; bz++) {
        const id = world.getBlock(bx, by, bz);
        if (id === AIR) continue;
        const ownRes = blastResistanceOf(id);
        if (ownRes === Infinity) continue; // 防爆方块：基岩/强化深板岩/黑曜石类（MC 爆炸抗性 1200+）
        if (isWaterId(id) || isLavaId(id)) continue; // 流体免疫爆炸（MC 一致）
        const d = Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z);
        if (d > R + 0.5) continue;
        // MC 逐方块爆炸抗性：途经格抗性 + 自身抗性折成等效距离，削弱破坏概率（黑曜石墙后概率≈0）
        const absorb = pathAbsorption(world, x, y, z, bx, by, bz);
        if (absorb === Infinity) continue;
        if (Math.random() < 1 - (d + absorb + ownRes) / strength) {
          const key = `${bx},${by},${bz}`;
          // 容器/熔炉被炸：内容物先掉落并清状态，否则原地重建会复活内容/幽灵烧炼
          if (id === BLOCK_BY_KEY.chest.id || id === BLOCK_BY_KEY.barrel.id) dropStorageContents(key, bx, by, bz);
          else if (id === FURNACE) dropFurnaceContents(key, bx, by, bz);
          // 正在查看被炸的容器/熔炉：顺便关闭界面
          const s = useGameStore.getState();
          if (s.storageOpen === key) s.setStorageOpen(null);
          if (s.furnaceOpen === key) s.setFurnaceOpen(null);
          world.setBlock(bx, by, bz, AIR);
          checkGravityAt(world, bx, by, bz); // 爆炸后上方重力方块失撑坠落（MC 方块更新）
          // TNT 被波及：转为点燃实体连锁引爆（MC 一致，不再掉方块；连锁引信随机 10-29 tick = 0.5-1.45s）
          if (id === BLOCK_BY_KEY.tnt.id) {
            igniteTnt(bx, by, bz, 0.5 + Math.random() * 0.95);
          } else {
            // 爆炸掉落（MC 1.14+）：TNT 100% 掉落，其他爆炸按 1/威力概率；防爆方块在上面已跳过
            const def = BLOCKS[id];
            if (def && Math.random() < (opts.tnt ? 1 : 1 / R)) {
              if (def.drop) {
                const [min, max] = def.drop.count;
                spawnMaterialDrop(def.drop.material, bx + 0.5, by + 0.4, bz + 0.5, min + Math.floor(Math.random() * (max - min + 1)));
              } else {
                spawnBlockDrop(def.dropBlock ?? id, bx + 0.5, by + 0.4, bz + 0.5);
              }
            }
          }
        }
      }
    }
  }
  // MC：爆炸冲击波把伤害半径内的已点燃 TNT 实体沿爆心向外弹开（冲量随距离衰减；实体侧只做速度积分+碰撞停，见 tickTnt）
  for (const t of primedTnt) {
    const dx = t.x - x;
    const dy = t.y - y;
    const dz = t.z - z;
    const d = Math.hypot(dx, dy, dz);
    if (d === 0 || d >= hurtRadius) continue;
    const k = (1 - d / hurtRadius) * 6; // 冲量强度（格/秒）
    t.vx = (t.vx ?? 0) + (dx / d) * k;
    t.vy += (dy / d) * k + k * 0.4; // 附带上抛分量，把实体抛离地面
    t.vz = (t.vz ?? 0) + (dz / d) * k;
  }
  const pd = Math.hypot(playerPos.x - x, playerPos.y + 0.9 - y, playerPos.z - z);
  if (pd < hurtRadius) {
    // MC：伤害 = 距离衰减 × 遮挡率；被实心方块完全遮挡时 ≈0（隔墙免伤，不再隔墙满伤）
    const exposure = explosionExposure(world, x, y, z, playerPos);
    if (exposure > 0) onAttackPlayer(Math.max(1, Math.round(maxDamage * (1 - pd / hurtRadius) * exposure)));
  }
  // 屏幕震动：按距离衰减（不算遮挡——隔墙也有闷响震感；比伤害半径多留 6 格余量），Player 帧循环消费 cameraShake
  addShake(Math.max(0, 1 - pd / (hurtRadius + 6)) * 0.8);
  for (let i = 0; i < 12; i++) breakParticles.push({ x: cx, y: cy, z: cz, tile: tileOf('stone') });
  playSound('dig_cracky', 0.4);
  boom();
}
