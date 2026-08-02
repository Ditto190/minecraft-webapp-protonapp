'use client';

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, type Color, type Fog } from 'three';
import { isLavaId, isWaterId, tileOf } from '@/lib/blocks';
import { atmosphere, breakParticles, getActiveWorld, survivalStats } from '@/lib/game';
import { useGameStore } from '@/lib/store';

const WATER_COLOR = '#16486e';
const WATER_FOG_NEAR = 1;
const WATER_FOG_FAR = 22;
const LAVA_COLOR = '#cf4a0a';
const LAVA_FOG_NEAR = 0.5;
const LAVA_FOG_FAR = 4;

/** 天空雾随渲染距离联动：覆盖最远 chunk，又不至于太近泛白 */
export function skyFog(renderDistance: number): { near: number; far: number } {
  return {
    near: renderDistance * 16 * 0.55,
    far: renderDistance * 16 + 16,
  };
}

/** 帧循环复用的相机朝向向量（气泡定位用，零分配） */
const bubbleDir = new Vector3();
/** 帧循环复用的天空雾距暂存（与 skyFog 同式原地写入，避免每帧两个小对象字面量） */
const fogScratch = { near: 0, far: 0 };

/** 头没入水中时切换为水下雾效，离开后恢复天空（雾距随设置）；水下间歇推呼出气泡粒子事件（breakParticles，BreakParticles 消费） */
export function UnderwaterFX() {
  /** 距下一朵呼出气泡的秒数（仅头入水时倒计时，出水重置） */
  const bubbleIn = useRef(0.5);

  useFrame(({ scene, camera }, delta) => {
    const world = getActiveWorld();
    if (!world) return;
    const fog = scene.fog as Fog | null;
    const bg = scene.background as Color | null;
    if (!fog || !bg) return;
    const head = world.getBlock(
      Math.floor(camera.position.x),
      Math.floor(camera.position.y),
      Math.floor(camera.position.z),
    );
    if (isWaterId(head)) {
      bg.set(WATER_COLOR);
      fog.color.set(WATER_COLOR);
      fog.near = WATER_FOG_NEAR;
      fog.far = WATER_FOG_FAR;
      // 呼出气泡：每 0.3-0.8s 随机在相机前方下方推一朵（氧气 <5s 快耗尽时频率加倍）；暂停时游戏逻辑冻结不推
      if (!useGameStore.getState().paused) {
        bubbleIn.current -= Math.min(delta, 0.05);
        if (bubbleIn.current <= 0) {
          camera.getWorldDirection(bubbleDir);
          const bx = camera.position.x + bubbleDir.x * 0.6;
          const by = camera.position.y + bubbleDir.y * 0.6 - 0.35;
          const bz = camera.position.z + bubbleDir.z * 0.6;
          // 粒子在事件坐标 +0.25~0.75 内散布（BreakParticles.spawn）：-0.5 使散布中心对准气泡点；贴图取水 tile（浅色水色）
          breakParticles.push({ x: bx - 0.5, y: by - 0.5, z: bz - 0.5, tile: tileOf('water_still') });
          bubbleIn.current = (0.3 + Math.random() * 0.5) * (survivalStats.air < 5 ? 0.5 : 1);
        }
      }
    } else {
      // 出水（含岩浆）即停：计时器重置，再入水按完整随机间隔起算
      bubbleIn.current = 0.3 + Math.random() * 0.5;
      if (isLavaId(head)) {
        // 头没入岩浆：橙红短雾
        bg.set(LAVA_COLOR);
        fog.color.set(LAVA_COLOR);
        fog.near = LAVA_FOG_NEAR;
        fog.far = LAVA_FOG_FAR;
      } else {
        // 恢复天空雾距（与 skyFog 同式，写模块级暂存避免每帧分配）；
        // 下界雾浓（MC 下界能见度低、红雾弥漫）；末地/主世界正常雾距
        const gs = useGameStore.getState();
        fogScratch.near = gs.settings.renderDistance * 16 * 0.55;
        fogScratch.far = gs.settings.renderDistance * 16 + 16;
        if (gs.dimension === 'nether') {
          fogScratch.near *= 0.3;
          fogScratch.far *= 0.5;
        }
        if (fog.near !== fogScratch.near || fog.far !== fogScratch.far) {
          // 恢复天空：颜色取 DayNight 当前计算的大气色
          bg.setRGB(atmosphere.r, atmosphere.g, atmosphere.b);
          fog.color.setRGB(atmosphere.r, atmosphere.g, atmosphere.b);
          fog.near = fogScratch.near;
          fog.far = fogScratch.far;
        }
      }
    }
  });

  return null;
}
