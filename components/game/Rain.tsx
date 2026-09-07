'use client';

// 降雨/雷暴：相机周围的竖直雨丝（lineSegments 循环下落），头顶有遮挡或在水下时不显示
// 雨声环境音（sound.ts startRain/stopRain）：随天气与本地降水开停/调强度，水下静音，雪天极轻
// 雨点落地溅射：下雨时（非雪天）间歇在相机周围裸露地表推少量淡蓝碎块粒子（breakParticles 事件，每次 ~10 粒）

import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, LineBasicMaterial, type LineSegments } from 'three';
import { BLOCKS, isLavaId, isWaterId, tileOf } from '@/lib/blocks';
import { breakParticles, getActiveWorld } from '@/lib/game';
import { startRain, stopRain } from '@/lib/sound';
import { weather, precipForBiome, type Precip } from '@/lib/weather';
import type { Biome } from '@/lib/noise';
import type { World } from '@/lib/world';

const MAX_DROPS = 900; // 雷暴密度
const RAIN_DROPS = 450; // 普通雨密度
const RADIUS = 22; // 水平散布半径
const TOP = 16; // 相机上方生成高度
const BOTTOM = 5; // 低于相机多少回收
const STREAK = 0.55; // 雨丝长度

// 模块级雨场状态：帧循环里直接改（与 digState/breakParticles 同模式）
const drops = new Float32Array(MAX_DROPS * 4); // 每滴：x, y, z, speed
const rainGeo = new BufferGeometry();
const rainPos = new Float32Array(MAX_DROPS * 2 * 3);
const rainAttr = new BufferAttribute(rainPos, 3);
rainAttr.setUsage(35048); // DynamicDrawUsage
rainGeo.setAttribute('position', rainAttr);
const rainMat = new LineBasicMaterial({ color: '#8fb3d9', transparent: true, opacity: 0.45, depthWrite: false });
const rainState = { seeded: false };

const SPLASH_RADIUS = 12; // 溅射水平散布半径（比雨丝小，只在近处出，少占粒子池）
/** 溅射节流：acc 累计 dt，到 next 推一朵；next 每次取 0.3-0.7s 随机（~2 朵/秒，克制） */
const splashState = { acc: 0, next: 0.5 };

/** 本地降水列缓存：biomeAt/snowlineAt 是多次噪声求值，按 (floor(x), floor(z), terrain) 缓存；
 *  雪线判断（y）与天气种类每帧现算（precipForBiome 是纯 switch，零噪声），与逐帧 precipAt 语义一致 */
const precipCache = { x: NaN, z: NaN, terrain: null as object | null, biome: 'plains' as Biome, snowline: Infinity };

/** 本地降水（MC：干旱群系无降水、寒冷群系与雪线以上下雪）；等价 precipAt(world.terrain, weather.kind, ...) 的缓存版 */
function localPrecip(world: World, bx: number, by: number, bz: number): Precip {
  const t = world.terrain;
  if (precipCache.terrain !== t || precipCache.x !== bx || precipCache.z !== bz) {
    precipCache.terrain = t;
    precipCache.x = bx;
    precipCache.z = bz;
    precipCache.biome = t.biomeAt(bx, bz);
    precipCache.snowline = t.snowlineAt(bx, bz);
  }
  return precipForBiome(precipCache.biome, by, precipCache.snowline);
}

/** 推一朵雨点落地溅射：相机周围随机水平位置，自上而下找首个裸露表面（实心块或水面——屋檐下/洞穴内的位置
 *  会先扫到其顶面，等价于跳过遮挡），y 取表面上方一格，碎块散布后受重力落回表面弹跳。
 *  经 breakParticles 推送（只读 import，每次事件 ~10 粒，取水面贴图出淡蓝碎块）；
 *  设置里关闭粒子时 BreakParticles 每帧丢弃整个队列，这里无需判断 */
function spawnSplash(world: World, cx: number, cy: number, cz: number): void {
  const x = cx + (Math.random() * 2 - 1) * SPLASH_RADIUS;
  const z = cz + (Math.random() * 2 - 1) * SPLASH_RADIUS;
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  const top = Math.floor(cy) + TOP;
  const bottom = Math.max(0, Math.floor(cy) - BOTTOM);
  for (let y = top; y >= bottom; y--) {
    const b = world.getBlock(bx, y, bz);
    if (BLOCKS[b]?.solid || isWaterId(b)) {
      breakParticles.push({ x, y: y + 1, z, tile: tileOf('water_still') });
      return;
    }
  }
}

export function Rain() {
  const ref = useRef<LineSegments>(null);
  // 已应用的雨声状态（''=静音）：仅变化时调 sound.ts，避免每帧重复 start/stop
  const audioRef = useRef('');

  // 卸载（切世界/回主菜单）停雨声
  useEffect(() => () => stopRain(), []);

  useFrame(({ camera }, delta) => {
    const lines = ref.current;
    if (!lines) return;
    /** 雨声目标状态（''=静音 / rain / thunder / snow）：startRain、stopRain 均幂等 */
    const applyAudio = (want: string) => {
      if (audioRef.current === want) return;
      audioRef.current = want;
      if (want === '') stopRain();
      else startRain(want === 'thunder' ? 1.5 : want === 'snow' ? 0.15 : 1); // 雷暴略响，雪天极轻
    };
    const raining = weather.kind !== 'clear';
    if (!raining) {
      lines.visible = false;
      rainState.seeded = false;
      applyAudio('');
      return;
    }
    const world = getActiveWorld();
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    // 本地降水（晴天已在上面 return，等价 precipAt 的 kind!=='clear' 分支）
    const precip = world ? localPrecip(world, Math.floor(cx), Math.floor(cy), Math.floor(cz)) : 'none';
    if (precip === 'none') {
      lines.visible = false;
      rainState.seeded = false;
      applyAudio('');
      return;
    }
    const snow = precip === 'snow';
    if (world) {
      const head = world.getBlock(Math.floor(cx), Math.floor(cy), Math.floor(cz));
      if (isWaterId(head) || isLavaId(head)) {
        lines.visible = false;
        applyAudio(''); // 头入水/岩浆：雨声隔断
        return;
      }
      // 头顶 24 格内有不透明遮挡（洞穴/屋内）则看不到雨（但仍闻雨声，MC 屋内听雨观感，不动 audioRef）
      for (let y = 1; y <= 24; y++) {
        const b = world.getBlock(Math.floor(cx), Math.floor(cy) + y, Math.floor(cz));
        if (BLOCKS[b]?.opaque) {
          lines.visible = false;
          return;
        }
      }
    }
    lines.visible = true;
    applyAudio(snow ? 'snow' : weather.kind);

    const count = weather.kind === 'thunder' ? MAX_DROPS : RAIN_DROPS;
    // 雪：白色、更慢、更短（雪片观感），横向飘移
    rainMat.color.set(snow ? '#eef4fb' : '#8fb3d9');
    rainMat.opacity = snow ? 0.8 : weather.kind === 'thunder' ? 0.6 : 0.45;
    const streak = snow ? 0.08 : STREAK;
    const dt = Math.min(delta, 0.05);
    // 雨点落地溅射：间歇推一朵（雪天不做）；头顶遮挡/水下已在上面 return，走到这里必然露天见雨
    if (!snow && world) {
      splashState.acc += dt;
      if (splashState.acc >= splashState.next) {
        splashState.acc = 0;
        splashState.next = 0.3 + Math.random() * 0.4;
        spawnSplash(world, cx, cy, cz);
      }
    }
    // 首次（或雨后重开）时在相机周围撒满
    if (!rainState.seeded) {
      rainState.seeded = true;
      for (let i = 0; i < MAX_DROPS; i++) {
        drops[i * 4] = cx + (Math.random() * 2 - 1) * RADIUS;
        drops[i * 4 + 1] = cy - BOTTOM + Math.random() * (TOP + BOTTOM);
        drops[i * 4 + 2] = cz + (Math.random() * 2 - 1) * RADIUS;
        drops[i * 4 + 3] = snow ? 2.5 + Math.random() * 1.5 : 18 + Math.random() * 6;
      }
    }
    const t = performance.now() / 1000;
    // 只推进/写当前密度的滴（普通雨 450，雷暴 900）；其余滴由 drawRange 截断不绘制，也不再逐帧写顶点
    for (let i = 0; i < count; i++) {
      const di = i * 4;
      drops[di + 1] -= drops[di + 3] * dt;
      if (snow) drops[di] += Math.sin(t * 1.5 + i) * 0.35 * dt; // 雪片横向飘移
      // 回收：落出下界或偏离相机过远
      const dx = drops[di] - cx;
      const dz = drops[di + 2] - cz;
      if (drops[di + 1] < cy - BOTTOM || dx * dx + dz * dz > RADIUS * RADIUS * 1.4) {
        drops[di] = cx + (Math.random() * 2 - 1) * RADIUS;
        drops[di + 1] = cy + TOP * (0.7 + Math.random() * 0.3);
        drops[di + 2] = cz + (Math.random() * 2 - 1) * RADIUS;
      }
      const pi = i * 6;
      const vy = drops[di + 1];
      rainPos[pi] = drops[di];
      rainPos[pi + 1] = vy;
      rainPos[pi + 2] = drops[di + 2];
      rainPos[pi + 3] = drops[di];
      rainPos[pi + 4] = vy + streak;
      rainPos[pi + 5] = drops[di + 2];
    }
    rainGeo.setDrawRange(0, count * 2); // 顶点数（每滴 2 端点）
    rainAttr.addUpdateRange(0, count * 6); // 只上传实际写入的 float 区间（渲染器上传后自动清范围）
    rainAttr.needsUpdate = true;
  });

  return (
    <lineSegments ref={ref} geometry={rainGeo} material={rainMat} frustumCulled={false} visible={false} />
  );
}
