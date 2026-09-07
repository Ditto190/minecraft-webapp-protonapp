'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Euler, PerspectiveCamera, Vector3 } from 'three';
import { BLOCK_BY_KEY, BLOCKS, isLavaId, isWaterId, tileOf } from '@/lib/blocks';
import { breakBlock, cancelEating, eatState, sweepAround, tickEating, tryPlace, useButton } from '@/lib/actions';
import { trampleFarmland } from '@/lib/crops';
import { effectiveDigTime } from '@/lib/dig';
import { attackState, bowState, breakParticles, burningState, cameraRef, cameraShake, debugInfo, digState, getActiveWorld, handSwing, hurtState, panelUnlock, pearlTeleport, playerPosition, portalState, SHAKE_DECAY_MS, survivalStats, targetBlock, teleportState, touchInput, worldClock } from '@/lib/game';
import { itemDrops } from '@/lib/items';
import { materialTile } from '@/lib/materials';
import { otherDimension } from '@/lib/dimension';
import { END_SPAWN } from '@/lib/end';
import { isPortalId } from '@/lib/portal';
import { outerHeightAt, pickOuterIsland } from '@/lib/end';
import { gatewayState } from '@/lib/endfight';
import { raycastBlock } from '@/lib/raycast';
import { resolveAnchorRespawn } from '@/lib/respawnanchor';
import { arrows, checkEndermanStare, damageMob, mobInReach, mobs, spawnMobAt, type Arrow, type Mob } from '@/lib/mobs';
import { crystalInReach, hitCrystal, tickCrystals } from '@/lib/endfight';
import { tickFishing } from '@/lib/fishing';
import { SEA_LEVEL, type Biome } from '@/lib/noise';
import { aabbFree, canRide, climbVelY, collideAxis, dismountRide, DoubleTap, isHappyGhast, mountRide, PLAYER_HALF_W, PLAYER_HEIGHT, rideControl, rideSnap, sneakEdgeClip, sprintSwimNext, stanceSpeedMult, SWIM_EYE, SWIM_HEIGHT, touchingVine, wSprintNext, type Aabb } from '@/lib/physics';
import { playSound, splashSound, hurtSound } from '@/lib/sound';
import { useGameStore } from '@/lib/store';
import { anyPanelOpen } from '@/lib/store-types';
import { resetSurvivalMem, tickSurvival, type SurvivalActions, type SurvivalEnv, type SurvivalMem, type SurvivalSnapshotLite } from '@/lib/survival';
import { effects, effectLvls, tickEffects } from '@/lib/effects';
import { beaconTiers, tickBeaconsThrottled } from '@/lib/beacon';
import { attackCooldownScale, TOOLS } from '@/lib/tools';
import { maceSmashBonus } from '@/lib/xp';
import { WORLD_HEIGHT, type World } from '@/lib/world';

const EYE = 1.62; // 视点高度
const WALK_SPEED = 4.3;
const FLY_SPEED = 11;
// 跳跃初速：跳高 = JUMP_VEL²/(2·GRAVITY)。对齐 MC 跳高 1.25 格（原值 9 跳出 1.56 格，能上 1.5 格方块，与 MC 不符）
const JUMP_VEL = 8.07;
const GRAVITY = 26;
const REACH = 6; // 挖掘/放置距离
/** 横扫粒子弧线：面前 ±40° 两簇（弧度） */
const SWEEP_ARC = [-0.7, 0.7] as const;
const LOOK_SENSITIVITY = 0.0045; // 触屏视角灵敏度（弧度/像素）
const SPAWN = { x: 8.5, z: 8.5 };

/** 每帧准星射线的原地写入输出对象（减少命中时的新对象分配）；结果再赋给 game.ts 的 targetBlock.hit */
const raycastHitOut = { block: [0, 0, 0] as [number, number, number], face: [0, 0, 0] as [number, number, number] };

/** 出生点避让：海洋/河流/蘑菇岛/山地（含雪顶）不适合出生（MC 出生点在平缓陆地） */
const BAD_SPAWN: Biome[] = ['ocean', 'river', 'mushroom_fields', 'mountains'];
const spawnCache = new WeakMap<World, { x: number; z: number }>();

/** 螺旋外扩找最近的平缓陆地列（8 格步进；结果按世界缓存，出生/重生一致） */
function resolveSpawnXZ(world: World): { x: number; z: number } {
  const hit = spawnCache.get(world);
  if (hit) return hit;
  let s = { x: Math.floor(SPAWN.x), z: Math.floor(SPAWN.z) };
  outer: for (let r = 0; r <= 48; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const bx = Math.floor(SPAWN.x) + dx * 8;
        const bz = Math.floor(SPAWN.z) + dz * 8;
        const h = world.terrain.heightAt(bx, bz);
        if (h <= SEA_LEVEL || h > 85) continue;
        if (BAD_SPAWN.includes(world.terrain.biomeAt(bx, bz))) continue;
        s = { x: bx, z: bz };
        break outer;
      }
    }
  }
  spawnCache.set(world, s);
  return s;
}

/**
 * 出生点：避开不宜居群系后，从地表向上找到能容纳玩家的连续 2 格非实心方块。
 * heightAt 不含树木/玩家放置的方块，直接用它可能卡进树干。
 */
function findSpawn(world: World): { x: number; y: number; z: number } {
  const { x: bx, z: bz } = resolveSpawnXZ(world);
  let y = Math.max(world.terrain.heightAt(bx, bz), SEA_LEVEL) + 1;
  while (
    y < WORLD_HEIGHT - 2 &&
    (BLOCKS[world.getBlock(bx, y, bz)]?.solid || BLOCKS[world.getBlock(bx, y + 1, bz)]?.solid)
  ) {
    y++;
  }
  return { x: bx + 0.5, y, z: bz + 0.5 };
}

/** 准星 reach 内最近的恶魂爆裂球（近战可打回的；已打回的视为玩家弹射物不再判定） */
function fireballInReach(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): Arrow | null {
  let best: Arrow | null = null;
  let bestT = reach;
  for (const a of arrows) {
    if (a.kind !== 'ghast' || a.fromPlayer) continue;
    const t = (a.x - ox) * dx + (a.y - oy) * dy + (a.z - oz) * dz;
    if (t < 0 || t > bestT) continue;
    const px = ox + dx * t;
    const py = oy + dy * t;
    const pz = oz + dz * t;
    if (Math.hypot(a.x - px, a.y - py, a.z - pz) < 1.2) {
      best = a;
      bestT = t;
    }
  }
  return best;
}

/** __mc 调试单例（自动化实测用）：模块级复用，帧循环原地覆写字段，避免开发/调试态每帧分配 20 字段大对象。
 *  静态字段（模块单例/函数引用）在此固定；逐帧字段（pos/tp/camera/scene/gl/fps/world/yawPitch）在帧循环覆写 */
const mcDebug: {
  pos: { x: number; y: number; z: number };
  tp: Aabb | null;
  [key: string]: unknown;
} = {
  pos: { x: 0, y: 0, z: 0 },
  pp: playerPosition, // 可写：测试传送（实际玩家状态在下方 tp）
  tp: null, // 当前帧的物理状态对象（重生等重赋值后会变；帧循环覆写）
  tpTo: (x: number, y: number, z: number) => {
    // 传送（对最近一帧的物理状态写字段；tp 每帧覆写，重生重赋值也安全）
    const t = mcDebug.tp;
    if (!t) return;
    t.x = x;
    t.y = y;
    t.z = z;
  },
  store: useGameStore,
  touch: touchInput,
  mobs, // 生物列表（只读排查用）
  clock: worldClock, // 昼夜时钟（可写）
  digState, // 挖掘进度（排障用）
  targetBlock, // 准星命中（排障用）
  drops: itemDrops, // 掉落物实体（排障用）
  spawn: spawnMobAt, // 生成生物（实测用）
  tryPlace, // 右键交互（实测用）
  mobInReach, // 准星内生物（实测用）
};

/** tickSurvival 参数对象（模块级复用：每帧写字段替代对象字面量分配；tickSurvival 只同步读值不保留引用） */
const survivalEnv: SurvivalEnv = { dt: 0, flying: false, inWater: false, headInWater: false, onGround: false, velY: 0, climbing: false };
const survivalSnap: SurvivalSnapshotLite = { worldMode: '', health: 0, hunger: 0, saturation: 0 };
const survivalActs: SurvivalActions = {
  damagePlayer: () => undefined,
  setHealth: () => undefined,
  setHunger: () => undefined,
  setSaturation: () => undefined,
};

export function Player() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const touchMode = useGameStore((s) => s.touchMode);
  const fov = useGameStore((s) => s.settings.fov);
  const sensitivity = useGameStore((s) => s.settings.sensitivity);
  const touchSensitivity = useGameStore((s) => s.settings.touchSensitivity);
  const invertY = useGameStore((s) => s.settings.invertY);
  const autoJump = useGameStore((s) => s.settings.autoJump);
  const pos = useRef<Aabb | null>(null);
  const velY = useRef(0);
  const onGround = useRef(false);
  const keys = useRef<Record<string, boolean>>({});
  /** 左键按住挖掘中（桌面端） */
  const digHeld = useRef(false);
  const rayDir = useMemo(() => new Vector3(), []);
  const euler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), []);
  /** 相机水平朝向（单位向量），垂直看时沿用上一帧 */
  const forward = useRef({ x: 0, z: -1 });
  /** 触屏模式的相机角度（桌面由下方 mousemove 监听维护） */
  const yawPitch = useRef({ yaw: 0, pitch: 0 });
  /** 脚步声：累计水平位移，每 2.2 格一步 */
  const stepAcc = useRef(0);
  /** 视角摆动（MC view bobbing）：相位由水平位移驱动，幅度随速度/状态缩放（空中/游泳/飞行渐停） */
  const bobPhase = useRef(0);
  const bobAmp = useRef(0);
  /** 落地短促下顿：幅度按落地速度缩放，sin 包络下顿后回弹 */
  const landDip = useRef({ amp: 0, t: 1 });
  /** 受伤相机倾斜（MC Java damage tilt）：hurtState.lastAt 边沿触发，随机侧 roll，0.4s 内衰减回正 */
  const hurtTilt = useRef({ at: Number.NEGATIVE_INFINITY, dir: 1 });
  const hurtSeen = useRef(Number.NEGATIVE_INFINITY);
  /** 已应用到相机的 roll：帧末按 delta 修正（桌面 mousemove 的四元数分解会保留 z 分量；触屏帧首欧拉重建时回填） */
  const appliedRoll = useRef(0);
  /** 挖掘敲击音计时（长按挖掘每 0.25s 一声低音量，挖碎瞬间的全音量音效走 breakBlock） */
  const digTapAcc = useRef(0);
  /** 进食碎屑计时（读条中每 0.2s 从相机下方推食物粒子） */
  const eatCrumbAcc = useRef(0);
  /** 入水/出水水花：上一帧水中状态（边沿检测）与触发冷却（水面小幅波动不反复响） */
  const wasInWater = useRef(false);
  const splashCd = useRef(0);
  /** 台阶辅助上台动画（150ms 平滑升起，避免瞬移突兀/起跳弹循环） */
  const stepAnim = useRef<{ from: number; to: number; t: number } | null>(null);
  const prevStep = useRef({ x: 0, z: 0 });
  /** 已应用到相机的 FOV，变化时在帧循环里同步 */
  const appliedFov = useRef(0);
  /** 生存：下落/憋气/回血计时（逻辑在 lib/survival.ts） / 攻击冷却 / 死亡边沿 */
  const survivalMem = useRef<SurvivalMem>({ fallDist: 0, air: 15, regenTick: 0, witherTick: 0, regenPotionTick: 0 });
  /** 岩浆灼烧累计（满 1 点扣 1 血） */
  const lavaAcc = useRef(0);
  const voidAcc = useRef(0);
  /** 着火计时（离开岩浆后续烧，MC 约 15s）与着火 DoT 累计 */
  const fireAcc = useRef(0);
  const fireDmgAcc = useRef(0);
  const attackCd = useRef(0);
  /** 当前武器的攻击总冷却 T（= 1/攻速），冷却进度条与伤害缩放用 */
  const attackCdTotal = useRef(0.25);
  /** 上一帧挖掘键按住状态（点按边沿检测：冷却未满时点击仍可出手，MC 1.9） */
  const digWasHeld = useRef(false);
  /** 冲刺击退后的冲刺中断剩余秒数（MC：冲刺命中后中断冲刺；限时恢复，触屏冲刺开关不被卡死） */
  const sprintBreak = useRef(0);
  /** 双击检测（MC Java ≤0.25s 窗口）：双击 W 冲刺 / 双击空格切飞行（创造） */
  const wTap = useRef(new DoubleTap(250));
  const spaceTap = useRef(new DoubleTap(250));
  /** 双击 W 触发的冲刺态（W 松开/停下即取消；与 Ctrl/触屏冲刺并存，任一激活） */
  const wSprint = useRef(false);
  /** 创造模式即时破坏的上次时间戳（200ms 冷却，防止按住左键每帧破一块） */
  const lastCreativeBreak = useRef(0);
  const wasDead = useRef(false);
  /** 下界传送门：门内停留计时（生存 4 秒 = MC 80 tick 触发传送；创造进立传） */
  const portalAcc = useRef(0);
  /** 末影人对视检查计时 */
  const stareAcc = useRef(0);
  /** 末影龙缓存：存活期内免每帧 mobs.find（被移除时 includes 失效重扫；龙只存在于末地维度） */
  const cachedDragon = useRef<Mob | null>(null);
  /** 冲刺游泳姿态（MC Java 1.13+ 俯泳：水中冲刺进入，碰撞箱降到 0.6 可过 1 格缝；进出条件在 lib/physics.ts） */
  const sprintSwim = useRef(false);
  /** 骑乘中的快乐恶魂（mob 引用；骑乘状态不进存档——重载后玩家就地落回地面，坐骑留在原处） */
  const riding = useRef<Mob | null>(null);

  // 维度切换：重置位置状态（落点由 WorldRenderer 经 spawnPoint 下发）
  const dimension = useGameStore((s) => s.dimension);
  useEffect(() => {
    pos.current = null;
    velY.current = 0;
    portalAcc.current = 0;
    portalState.charge = 0; // 跨维度后门内读秒归零（屏幕紫色渐进 overlay 消费）
    // 骑乘不跨维度：mobs 作用域切维度整体 clear（不暂存，见 mobs.ts registerWorldScope），旧坐骑对象随之销毁，无需解标记
    if (riding.current) {
      dismountRide(riding.current);
      riding.current = null;
    }
    sprintSwim.current = false; // 俯泳姿态重置（落点未必在水中）
  }, [dimension]);

  // 相机共享给触屏挖/放动作（lib/actions.ts）
  useEffect(() => {
    cameraRef.current = camera;
    return () => {
      cameraRef.current = null;
    };
  }, [camera]);

  // 键盘：移动键状态 + F 飞行 + F3 调试 + 数字键选槽
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // 输入框聚焦时不劫持按键（选块搜索框等），否则 e/f/数字会触发关界面/飞行/切槽
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      keys.current[e.code] = true;
      if (e.repeat) return;
      if (e.code === 'KeyF') useGameStore.getState().toggleFly();
      // MC Java 双击 W 冲刺：0.25s 内第二次按下激活（按住即冲刺，松开/停下取消；与 Ctrl 并存）
      if (e.code === 'KeyW' && wTap.current.press(performance.now())) wSprint.current = true;
      // MC Java 创造双击空格切飞行：第一次按下是正常跳（连跳），第二击才切换；toggleFly 内部已门禁仅创造
      if (e.code === 'Space' && spaceTap.current.press(performance.now())) useGameStore.getState().toggleFly();
      if (e.code === 'KeyE') {
        const s = useGameStore.getState();
        if (s.dead) return; // 死亡后不响应交互键
        if (s.worldMode === 'survival') {
          // MC 的背包键：切换随身 2×2 合成界面
          if (s.craftingOpen) s.setCraftingOpen(false);
          else s.setCraftingOpen(true, false);
        } else {
          // 创造模式：切换选块界面
          s.setPickerOpen(!s.pickerOpen);
        }
      }
      if (e.code === 'F3') {
        e.preventDefault();
        useGameStore.getState().toggleDebug();
      }
      // MC Java Q 丢弃：丢手持 1 个、Ctrl+Q 丢整组（GUI 打开时由 McGui 的悬停 Q 处理，世界内不重复丢）
      if (e.code === 'KeyQ') {
        const s = useGameStore.getState();
        if (!s.dead && !anyPanelOpen(s)) s.dropSelected(e.ctrlKey || e.metaKey);
      }
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        // GUI 打开时数字键走悬停快移（McGui），不切选中槽（MC Java）
        if (n >= 1 && n <= 9 && !anyPanelOpen(useGameStore.getState())) useGameStore.getState().setSlot(n - 1);
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
      if (e.code === 'KeyW') wSprint.current = false; // 双击 W 冲刺：松开即取消（MC Java）
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 滚轮切换热键栏：累计 deltaY 过阈值才切一格，避免触控板连跳
  useEffect(() => {
    const THRESHOLD = 40;
    const IDLE_RESET = 300; // ms
    let acc = 0;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      const now = performance.now();
      if (now - last > IDLE_RESET) acc = 0;
      last = now;
      acc += e.deltaY;
      if (Math.abs(acc) < THRESHOLD) return;
      const s = useGameStore.getState();
      s.setSlot((s.selectedSlot + (acc > 0 ? 1 : -1) + 9) % 9);
      acc = 0;
    };
    window.addEventListener('wheel', onWheel);
    return () => window.removeEventListener('wheel', onWheel);
  }, [gl]);

  // 指针锁状态 → 暂停遮罩；解锁时清空按键防止卡住。触屏模式无指针锁，不追踪
  useEffect(() => {
    if (touchMode) {
      useGameStore.getState().setPaused(false);
      return;
    }
    const onLockChange = () => {
      const locked = document.pointerLockElement === gl.domElement;
      useGameStore.getState().setPaused(!locked);
      if (locked) useGameStore.getState().setHasLocked(true);
      if (!locked) {
        keys.current = {};
        digHeld.current = false;
        useButton.held = false; // 退锁视同松开右键：进食读条随下一帧 tickEating 取消
      }
    };
    document.addEventListener('pointerlockchange', onLockChange);
    onLockChange();
    return () => document.removeEventListener('pointerlockchange', onLockChange);
  }, [gl, touchMode]);

  // 桌面鼠标视角：指针锁内 mousemove → 相机欧拉角（YXZ，俯仰限 ±90°，同 three PointerLockControls，
  // 但支持反转 Y——drei/three 的 PointerLockControls 无此选项，故自实现）。触屏走 useFrame 里的拖动逻辑
  useEffect(() => {
    if (touchMode) return;
    const lookEuler = new Euler(0, 0, 0, 'YXZ');
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      lookEuler.setFromQuaternion(camera.quaternion);
      lookEuler.y -= e.movementX * 0.002 * sensitivity;
      lookEuler.x -= e.movementY * 0.002 * sensitivity * (invertY ? -1 : 1);
      lookEuler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, lookEuler.x));
      camera.quaternion.setFromEuler(lookEuler);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [camera, gl, sensitivity, invertY, touchMode]);

  // 面板全关后自动回指针锁（MC：关背包直接回游戏，无需再点「继续游戏」）。
  // 仅当退锁原因是「打开面板」（panelUnlock.pending）时回锁；用户主动 Esc 暂停无此标记，仍出暂停遮罩
  const panelOpen = useGameStore(anyPanelOpen);
  useEffect(() => {
    if (touchMode || panelOpen || !panelUnlock.pending) return;
    panelUnlock.pending = false;
    const gs = useGameStore.getState();
    // 死亡/已回菜单/已有锁的场景不回锁（死亡与暂停界面需要光标）
    if (gs.dead || gs.screen !== 'playing' || document.pointerLockElement) return;
    const canvas = gl.domElement;
    const request = () => canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    // Chrome 在退锁后 ~1.25s 内会拒绝再次锁定（同 Hud PauseOverlay 的冷却处理）：被拒则冷却结束后再试一次
    request()?.catch(() => {
      setTimeout(() => {
        const s = useGameStore.getState();
        if (document.pointerLockElement || anyPanelOpen(s) || s.dead || s.screen !== 'playing') return;
        request()?.catch(() => {
          // 仍被拒：保持暂停遮罩，玩家可手动点「继续游戏」
        });
      }, 1300);
    });
  }, [panelOpen, gl, touchMode]);

  // —— 骑乘（快乐恶魂）交互闭包：右键上马 / 下马（规则纯函数在 lib/physics.ts，可单测） ——

  /** 下马（Shift+右键 / 触屏潜行开关 / 死亡 / 坐骑失效自动）：解标记、从坐骑头顶就地落回普通物理 */
  const doDismount = useCallback(() => {
    dismountRide(riding.current);
    riding.current = null;
    velY.current = 0;
  }, []);

  /**
   * 右键快乐恶魂上马（MC 1.21.6）：空手或任意手持均可——已装鞍（harnessed，防御读取，约定见 physics.ts）即骑乘。
   * 未装鞍：空手 → 提示「需要鞍具」并吞掉右键；手持物品 → 放行（装鞍/喂雪球交互在 actions.ts 的 mob 右键路径）。
   * 返回 true = 已消费这次右键（上马成功或已提示），不再走 tryPlace。
   */
  const tryMountGhast = useCallback((): boolean => {
    const world = getActiveWorld();
    const cam = cameraRef.current;
    if (!world || !cam) return false;
    cam.getWorldDirection(rayDir);
    const mob = mobInReach(world, cam.position.x, cam.position.y, cam.position.z, rayDir.x, rayDir.y, rayDir.z, REACH);
    if (!isHappyGhast(mob)) return false; // 不是快乐恶魂：走正常右键（交易/喂食/放置等）
    const s = useGameStore.getState();
    if (!canRide(mob)) {
      if (s.hotbarSlots[s.selectedSlot]) return false; // 手持物品放行给装鞍/喂食路径
      s.setNotice('需要鞍具');
      return true;
    }
    if (!mountRide(mob)) return false; // 防御：同帧死亡等竞态
    riding.current = mob;
    stepAnim.current = null; // 上马瞬间打断台阶辅助动画（避免与吸附抢 y）
    if (eatState.active) cancelEating(); // 上马打断进食/饮用读条（MC：上马取消使用动作）
    return true;
  }, [rayDir]);

  // 鼠标：左键按住挖掘，右键放置（触屏走 TouchControls）
  useEffect(() => {
    touchInput.mountGhast = tryMountGhast; // 触屏上马桥（TouchControls 在 tryPlace 前消费）
    return () => {
      touchInput.mountGhast = null;
    };
  }, [tryMountGhast]);

  // 鼠标：左键按住挖掘，右键放置（触屏走 TouchControls）
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (document.pointerLockElement !== gl.domElement) return;
      if (e.button === 0) digHeld.current = true;
      else if (e.button === 2) {
        useButton.held = true; // 进食读条等的「按住使用」状态（lib/actions.ts）
        if (riding.current) {
          // 骑乘中：Shift+右键下马（Java 潜行下马——桌面 Shift 已兼下降键，故加右键组合）；其余右键不触发放置/使用
          if (keys.current['ShiftLeft'] || keys.current['ShiftRight']) doDismount();
        } else if (tryMountGhast()) {
          // 上马成功（或空手提示需要鞍具）：这次右键已消费
        } else if (tryPlace()) handSwing.at = performance.now(); // 放置成功：播一次手部挥动（触屏放置走 TouchControls 直调 tryPlace，不经此处）
      } else if (e.button === 1) {
        // 中键选块（MC pick block）：取准星方块到手上
        e.preventDefault(); // 阻止浏览器中键自动滚动
        const hit = targetBlock.hit;
        const w = getActiveWorld();
        const id = hit && w ? w.getBlock(hit.block[0], hit.block[1], hit.block[2]) : undefined;
        if (id !== undefined) useGameStore.getState().pickBlock(id);
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) digHeld.current = false;
      else if (e.button === 2) useButton.held = false;
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [gl, tryMountGhast, doDismount]);

  // 物理与移动
  useFrame((state, delta) => {
    const world = getActiveWorld();
    if (!world) return;
    const dt = Math.min(delta, 0.05);

    // 调试钩子（自动化实测用；开发环境，或生产带 ?mcdebug 时暴露——正常用户不可见）。模块级单例原地覆写，零分配
    if (process.env.NODE_ENV === 'development' || window.location.search.includes('mcdebug')) {
      mcDebug.pos.x = playerPosition.x;
      mcDebug.pos.y = playerPosition.y;
      mcDebug.pos.z = playerPosition.z;
      mcDebug.tp = pos.current;
      mcDebug.camera = state.camera;
      mcDebug.scene = state.scene;
      mcDebug.gl = state.gl;
      mcDebug.fps = debugInfo.fps;
      mcDebug.world = world;
      mcDebug.yawPitch = yawPitch.current; // 触屏视角（可写：自动化对准）
      mcDebug.riding = riding.current; // 骑乘中的坐骑（只读排查用；happy_ghast 骑乘系统）
      (window as unknown as { __mc?: unknown }).__mc = mcDebug;
    }

    // FOV：设置基准值 + 冲刺时 +10%（MC 冲刺视角；俯泳冲刺同样按键故同样放大），平滑过渡。骑乘中不放大（MC 骑乘无冲刺视角）
    {
      const cam = state.camera as PerspectiveCamera;
      const sprintKey = !riding.current && (keys.current['ControlLeft'] || keys.current['ControlRight'] || touchInput.sprint || wSprint.current);
      const targetFov = fov * (sprintKey ? 1.1 : 1);
      if (Math.abs(cam.fov - targetFov) > 0.05) {
        cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 10);
        cam.updateProjectionMatrix();
      }
      appliedFov.current = cam.fov;
    }

    // 触屏：用拖动增量驱动相机偏航/俯仰（独立灵敏度 touchSensitivity；反转 Y 与鼠标共用 invertY 设置，同 MC PE）
    if (touchMode) {
      const yp = yawPitch.current;
      yp.yaw -= touchInput.lookDX * LOOK_SENSITIVITY * touchSensitivity;
      yp.pitch = Math.min(
        Math.max(yp.pitch - touchInput.lookDY * LOOK_SENSITIVITY * touchSensitivity * (invertY ? -1 : 1), -Math.PI / 2 + 0.01),
        Math.PI / 2 - 0.01,
      );
      touchInput.lookDX = 0;
      touchInput.lookDY = 0;
      camera.quaternion.setFromEuler(euler.set(yp.pitch, yp.yaw, appliedRoll.current)); // z 回填已应用 roll：帧末 roll 修正是 delta 形式
    }

    if (pos.current === null) {
      // 继续游戏回上次位置，新游戏用默认出生点
      const sp = useGameStore.getState().spawnPoint;
      pos.current = sp
        ? { x: sp.x, y: sp.y, z: sp.z }
        : findSpawn(world);
      prevStep.current = { x: pos.current.x, z: pos.current.z };
      // 预生成出生点附近 chunk，保证落地有碰撞体
      const scx = Math.floor(pos.current.x / 16);
      const scz = Math.floor(pos.current.z / 16);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) world.getChunk(scx + dx, scz + dz);
      }
    }
    const p = pos.current;
    const flying = useGameStore.getState().flying;
    const gs = useGameStore.getState();

    // 重生传送（dead → alive 边沿）：回床/重生锚设的重生点（未设回世界出生点，MC）并重置生存状态
    if (wasDead.current && !gs.dead) {
      let sp = gs.respawnPoint;
      if (sp) {
        // 重生锚（MC）：锚在且有剩余档位 → 耗 1 档在锚旁重生；档尽/锚失效 → 重生点失效
        const ar = resolveAnchorRespawn(world, sp);
        if (ar === 'exhausted') {
          // 本次仍回锚旁（耗掉最后一档），此后重生点失效
          gs.setRespawnPoint(null);
          gs.setNotice('重生锚能量耗尽，重生点已失效');
        } else if (ar === 'depleted') {
          gs.setRespawnPoint(null);
          gs.setNotice('重生锚没有能量，重生点已失效');
          sp = null;
        }
      }
      const fb = findSpawn(world);
      p.x = sp?.x ?? fb.x;
      p.z = sp?.z ?? fb.z;
      p.y = sp?.y ?? fb.y;
      velY.current = 0;
      resetSurvivalMem(survivalMem.current);
      survivalStats.exhaustion = 0;
      prevStep.current = { x: p.x, z: p.z };
      wasInWater.current = false; // 重生后水中状态重新计边沿（避免在重生点播一声虚假出水水花）
    }
    wasDead.current = gs.dead;
    // 死亡：冻结等待重生界面操作
    if (gs.dead) {
      if (riding.current) doDismount(); // 死亡落马（MC：死亡脱离载具）
      useButton.held = false;
      if (eatState.active) cancelEating(); // 死亡打断进食/饮用读条（MC：死亡取消使用动作）
      bowState.draw = 0; // 死亡松弦（HeldItem 拉弦动画消费）
      portalState.charge = 0; // 死亡后传送门读秒归零（不再推进，死亡界面下不该残留紫色 overlay）
      return;
    }
    // Esc 暂停（指针解锁）：物理/挖掘/生存 tick 全部冻结；触屏 paused 恒 false 不受影响
    if (gs.paused) return;

    // 骑乘校验：坐骑死亡/被移除（含卸鞍 harnessed 变 false）→ 自动下马，落回普通物理（骑乘不进存档，重载即落地）
    if (riding.current && (!mobs.includes(riding.current) || !canRide(riding.current))) doDismount();
    const ridingNow = riding.current !== null;

    // 视点高度：俯泳 0.4（MC Java），其余 1.62（潜行 -0.12 在相机段处理）
    const eyeH = sprintSwim.current ? SWIM_EYE : EYE;
    // 水体检测：脚或头在水中（飞行时忽略）
    const inWater =
      isWaterId(world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z))) ||
      isWaterId(world.getBlock(Math.floor(p.x), Math.floor(p.y + eyeH), Math.floor(p.z)));
    // 岩浆检测：接触即受伤，泳动比水更粘滞
    const inLava =
      isLavaId(world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z))) ||
      isLavaId(world.getBlock(Math.floor(p.x), Math.floor(p.y + eyeH), Math.floor(p.z)));
    const inFluid = inWater || inLava;
    // 入水/出水水花：水中状态边沿触发（入水重、出水轻）；0.5s 冷却，水面小幅波动/上下浮动不反复响
    splashCd.current = Math.max(0, splashCd.current - dt);
    if (inWater !== wasInWater.current) {
      wasInWater.current = inWater;
      if (splashCd.current <= 0) {
        splashCd.current = 0.5;
        splashSound(inWater ? 0.6 : 0.25);
      }
    }

    // 按相机实际朝向（投影到水平面）计算移动方向。
    // 注意不能读 camera.rotation.y：rotation 是 XYZ 欧拉角分解，俯仰时 .y 不是真实偏航角
    camera.getWorldDirection(rayDir);
    const fLen = Math.hypot(rayDir.x, rayDir.z);
    if (fLen > 1e-4) {
      // 垂直看时退化，沿用上一帧的水平朝向
      forward.current.x = rayDir.x / fLen;
      forward.current.z = rayDir.z / fLen;
    }
    const fx = forward.current.x;
    const fz = forward.current.z;

    // 输入合并：键盘 + 触屏摇杆/按钮
    const space = keys.current['Space'] || touchInput.jump;
    const shift = keys.current['ShiftLeft'] || keys.current['ShiftRight'] || touchInput.down;
    const f = (keys.current['KeyW'] ? 1 : 0) - (keys.current['KeyS'] ? 1 : 0) + touchInput.moveY;
    const r = (keys.current['KeyD'] ? 1 : 0) - (keys.current['KeyA'] ? 1 : 0) + touchInput.moveX;
    // 双击 W 冲刺取消：W 已松开（退锁清键兜底）或不再前移（停下），MC Java
    wSprint.current = wSprintNext(wSprint.current, keys.current['KeyW'] === true, f);
    // MC 潜行：地面按 Shift（水中/飞行时是下降键）；冲刺：Ctrl（MC Java 同款）。触屏对应 touchInput.sneak/sprint 切换开关。骑乘中 Shift 是坐骑下降键，不算潜行
    const sneaking = !ridingNow && (shift || touchInput.sneak) && !flying && !inFluid;
    // 冲刺：Ctrl 或双击 W（MC Java 两种触发并存）。饥饿 ≤6（3 格）禁止冲刺（MC 门禁）；冲刺命中后的中断期内也不冲刺。骑乘中无冲刺（坐骑速度固定）
    const sprinting =
      !ridingNow &&
      (keys.current['ControlLeft'] || keys.current['ControlRight'] || touchInput.sprint || wSprint.current) &&
      !sneaking && !flying && sprintBreak.current <= 0 &&
      (gs.worldMode !== 'survival' || gs.hunger > 6);
    // 冲刺游泳（MC Java 1.13+ 俯泳）：水中冲刺进入；出水/松冲刺/站底退出；头顶容不下站姿时保持低姿态（1 格缝不卡天花板）
    const swimHeadroom = aabbFree(world, p.x, p.y, p.z, PLAYER_HALF_W, PLAYER_HEIGHT);
    sprintSwim.current = !ridingNow && sprintSwimNext(sprintSwim.current, inWater, sprinting, onGround.current, swimHeadroom);
    /** 本帧碰撞箱高度：俯泳 0.6（可过 1 格缝，MC Java），其余 1.8 */
    const hitH = sprintSwim.current ? SWIM_HEIGHT : PLAYER_HEIGHT;
    // 前进 = (fx, fz)，右 = 前进 × up = (-fz, fx)
    let mx = fx * f - fz * r;
    let mz = fz * f + fx * r;
    const mLen = Math.hypot(mx, mz);
    const speed =
      (flying ? FLY_SPEED : inFluid ? WALK_SPEED * (inLava ? 0.4 : 0.6) : WALK_SPEED) *
      (effects.speed > 0 ? 1 + 0.2 * Math.max(effectLvls.speed, beaconTiers.get('speed') ?? 1) : 1) * // 迅捷药水 +20%/级（II 级 +40%）
      stanceSpeedMult(sneaking, sprinting, sprintSwim.current && inWater) * // MC 潜行 ~0.3、冲刺 ~1.3、俯泳 ~1.35（仅水中；lib/physics.ts）
      (eatState.active ? 0.3 : 1); // MC Java：进食/饮用中移动速度大减（≈潜行速度）
    // 摇杆为模拟量：mLen ≤ 1 时保留力度，超过 1（键盘对角线）才归一化
    const scale = mLen > 1 ? speed / mLen : speed;
    mx *= scale;
    mz *= scale;
    // 骑乘中：水平输入转交坐骑（下方骑乘块移动坐骑），玩家自身不位移、不做碰撞
    if (ridingNow) {
      mx = 0;
      mz = 0;
    }
    // 藤蔓攀爬（MC Java CLIMBABLE）：AABB 与藤蔓同格/相贴即进入攀爬态；飞行/水中不攀爬（水中走游泳，飞行走飞行）；骑乘中不攀爬
    const climbing = !ridingNow && !flying && !inFluid && touchingVine(world, p, PLAYER_HALF_W, hitH);
    // 鞘翅滑翔（MC）：空中按住跳跃键且胸甲槽为鞘翅 → 朝视线方向推进，缓降（俯仰调制：俯视加速、仰视拉升）。骑乘中空格是坐骑上升键，不滑翔
    const gliding =
      !ridingNow &&
      !flying &&
      !climbing &&
      !onGround.current &&
      velY.current <= 0.01 &&
      space &&
      !inFluid &&
      gs.armorSlots.chestplate?.material === 'elytra';
    if (gliding) {
      const pitch = Math.atan2(rayDir.y, Math.max(fLen, 1e-4)); // 上正下负
      const glideSpeed = 10 + Math.min(Math.max(-pitch, -0.9), 0.9) * 6; // ~5 到 ~15
      mx = fx * glideSpeed;
      mz = fz * glideSpeed;
      velY.current = Math.max(velY.current - GRAVITY * 0.12 * dt, -3);
      if (pitch > 0.35) velY.current = Math.min(velY.current + 3 * dt, 0.5); // 仰视拉升
    }
    let wantX = p.x + mx * dt;
    let wantZ = p.z + mz * dt;
    // MC 潜行防跌落：着地潜行时，目标轴向前沿脚下无实体支撑则截停该轴移动（规则在 lib/physics.ts sneakEdgeClip；
    // 只防水平走出——跳跃/飞行/攀爬/水中 active=false 原样放行，不影响自动跳跃的碰撞检测）
    const clipped = sneakEdgeClip(world, p, wantX, wantZ, mx, mz, sneaking && onGround.current);
    wantX = clipped.x;
    wantZ = clipped.z;
    p.x = wantX;
    const hitX = collideAxis(world, p, 0, mx * dt, PLAYER_HALF_W, hitH);
    p.z = wantZ;
    const hitZ = collideAxis(world, p, 2, mz * dt, PLAYER_HALF_W, hitH);

    // 台阶辅助（设置「自动跳跃」，MC 辅助功能）：着地行走被 1 格高障碍挡住时启动 150ms 上台动画
    //（平滑升起 + 前冲，观感是快速小跳——不是瞬移闪现，也不会像起跳那样弹回）
    if (autoJump && !flying && onGround.current && !stepAnim.current && (hitX || hitZ)) {
      // 障碍格在被挡方向的下一格（不是玩家自身格——wantX/wantZ 被碰撞推回后仍在原地，查自身格恒为空导致辅助失效）
      const tryStep = (ax: number, az: number): boolean => {
        const bx = Math.floor(p.x) + ax;
        const bz = Math.floor(p.z) + az;
        const groundLevel = Math.floor(p.y + 1) - 1; // 台阶顶面所在方块层
        if (!BLOCKS[world.getBlock(bx, groundLevel, bz)]?.solid) return false;
        // 台阶顶上方需容得下玩家（天花板下不触发）
        if (!aabbFree(world, p.x + ax * 0.4, p.y + 1, p.z + az * 0.4, PLAYER_HALF_W, hitH)) return false;
        stepAnim.current = { from: p.y, to: p.y + 1, t: 0 };
        onGround.current = false;
        return true;
      };
      if (hitX && tryStep(Math.sign(mx), 0)) {
        // stepping
      } else if (hitZ) tryStep(0, Math.sign(mz));
    }
    // 上台动画推进：150ms 平滑升到台阶顶（期间保持前冲；动画里不做重力）
    if (stepAnim.current) {
      const a = stepAnim.current;
      a.t += dt / 0.15;
      if (a.t >= 1) {
        p.y = a.to;
        stepAnim.current = null;
        velY.current = 0;
        onGround.current = true;
      } else {
        const k = a.t * a.t * (3 - 2 * a.t); // smoothstep
        p.y = a.from + (a.to - a.from) * k;
        velY.current = 0;
        onGround.current = false;
      }
    }

    // 垂直方向
    if (ridingNow) {
      // 骑乘中：自身无重力/无跳跃（位置由坐骑吸附驱动，见下方骑乘块；空格/Shift 是坐骑升/降键）
      velY.current = 0;
      onGround.current = false;
    } else if (flying) {
      const up = (space ? 1 : 0) - (shift ? 1 : 0);
      velY.current = up * FLY_SPEED;
      onGround.current = false;
    } else if (inFluid) {
      // 游泳：弱化重力缓慢下沉，按住空格持续上浮；站在底面时可小跳上岸（岩浆里更粘）
      const visc = inLava ? 0.55 : 1;
      velY.current -= GRAVITY * 0.35 * visc * dt;
      if (space) {
        if (onGround.current) velY.current = JUMP_VEL * 0.7;
        else velY.current += GRAVITY * 1.1 * visc * dt;
      }
      velY.current = Math.min(Math.max(velY.current, -3), 4);
    } else if (stepAnim.current) {
      // 上台动画期间：y 由动画驱动，重力/跳跃不干预
      velY.current = 0;
    } else if (climbing) {
      // 藤蔓攀爬（MC Java）：按住前进缓慢上升，松开悬停不下坠，Shift 停住不动；无重力/跳跃，摔落距离由 tickSurvival 清零
      velY.current = climbVelY(shift, f);
      onGround.current = false;
    } else {
      if (effects.levitation > 0) {
        // 漂浮：匀速上浮（MC 潜影贝弹命中效果；期间跳跃/重力不生效）
        velY.current = 1.8;
        onGround.current = false;
      } else if (!gliding) {
        velY.current = Math.max(velY.current - GRAVITY * dt, -50);
        if (space && onGround.current) {
          velY.current = JUMP_VEL * (effects.jumpBoost > 0 ? 1 + 0.2 * (beaconTiers.get('jumpBoost') ?? 1) : 1); // 跳跃提升（信标）：I 级约 1.8 格（MC 跳跃 I），II 级更高
          onGround.current = false;
          if (gs.worldMode === 'survival') survivalStats.exhaustion += sprinting ? 0.2 : 0.05; // MC：冲刺跳 0.2/次，普通跳跃 0.05
        }
      }
    }
    const dy = velY.current * dt;
    p.y += dy;
    const hitY = collideAxis(world, p, 1, dy, PLAYER_HALF_W, hitH);
    if (hitY) {
      if (dy < 0) {
        onGround.current = true;
        // 落地反馈（|v|=√(2·GRAVITY·h)，阈值 7 ≈ 下落 1 格）：播脚下方块脚步声（低音量、潜行更轻，与行走脚步呼应），
        // 并触发短促相机下顿——幅度按落地速度缩放，跳落 1 格（落地 |v|≈8）几乎无感、高落明显
        if (velY.current <= -7 && !flying) {
          const tx = Math.floor(p.x);
          const ty = Math.floor(p.y - 0.01);
          const tz = Math.floor(p.z);
          const landSnd = BLOCKS[world.getBlock(tx, ty, tz)]?.stepSound;
          if (landSnd) playSound(landSnd, sneaking ? 0.2 : 0.45);
          landDip.current.amp = Math.min(0.22, (-velY.current - 7) * 0.016);
          landDip.current.t = 0;
          // 踩踏耕地：摔落砸到耕地上踩回泥土、其上作物弹出（MC 规则，逻辑在 lib/crops.ts trampleFarmland）。
          // Java 按摔落距离概率判定，简化为「摔落 >1 格即踩坏」（与上方落地反馈共用阈值）
          if (trampleFarmland(world, tx, ty, tz)) playSound('dig_dirt');
        }
      }
      velY.current = 0;
    } else if (dy !== 0) {
      onGround.current = false;
    }

    // —— 骑乘（快乐恶魂）：WASD 沿视线水平控制坐骑、空格上升 / Shift 下降；玩家吸附坐骑头顶（y+2.2） ——
    //（垂直从简用空格/Shift——Java 是视线俯仰控制上下，按键方案与触屏（跳=升/下=降）统一、实现更干净；规则在 lib/physics.ts rideControl）
    if (riding.current) {
      const mount = riding.current;
      rideControl(world, mount, fx, fz, f, r, (space ? 1 : 0) - (shift ? 1 : 0), dt);
      mount.velY = 0; // 双保险：约定 mobs.ts 对 riddenByPlayer 个体跳过 AI/物理，这里仍清 velY 防积分漂移
      rideSnap(p, mount);
      velY.current = 0;
      onGround.current = false;
      survivalMem.current.fallDist = 0; // 骑乘不累计摔落距离（下马后才恢复正常物理结算）
      if (touchInput.sneak) {
        // 触屏下马：潜行开关（桌面 Shift 已兼下降键，下马用 Shift+右键，见 mousedown）
        touchInput.sneak = false;
        doDismount();
      }
    }

    // —— 生存模式数值（掉落/溺水/消耗度/回血，逻辑在 lib/survival.ts） ——
    // 鞘翅滑翔中不累计摔落高度（MC：滑翔着陆无摔落伤害）
    if (gliding) survivalMem.current.fallDist = 0;
    const headInWater = isWaterId(
      world.getBlock(Math.floor(p.x), Math.floor(p.y + eyeH), Math.floor(p.z)),
    );
    survivalEnv.dt = dt;
    survivalEnv.flying = flying;
    survivalEnv.inWater = inWater;
    survivalEnv.headInWater = headInWater;
    survivalEnv.onGround = onGround.current;
    survivalEnv.velY = velY.current;
    survivalEnv.climbing = climbing; // 藤蔓攀爬：tickSurvival 按攀爬清零摔落距离（MC Java 攀爬免摔伤）
    survivalSnap.worldMode = gs.worldMode;
    survivalSnap.health = gs.health;
    survivalSnap.hunger = gs.hunger;
    survivalSnap.saturation = gs.saturation;
    survivalActs.damagePlayer = gs.damagePlayer;
    survivalActs.setHealth = gs.setHealth;
    survivalActs.setHunger = gs.setHunger;
    survivalActs.setSaturation = gs.setSaturation;
    tickSurvival(survivalEnv, survivalMem.current, survivalSnap, survivalActs);
    survivalStats.air = survivalMem.current.air; // 镜像给 HUD 气泡条（氧气 15s，见 lib/survival.ts）

    // 岩浆灼烧：接触即掉血（4 心/秒，MC；抗火药水免疫）；离开后再烧 ~15s（着火 1 点/秒，入水熄灭）
    if (inLava && gs.worldMode === 'survival' && effects.fireRes <= 0) {
      fireAcc.current = 15;
      lavaAcc.current += dt * 8;
      const dmg = Math.floor(lavaAcc.current);
      // damagePlayer 在 500ms 受击无敌帧内返回 false：伤害被拒时不扣累计（否则 DoT 被无敌帧吞掉，实际 DPS 减半）
      if (dmg > 0 && gs.damagePlayer(dmg)) {
        lavaAcc.current -= dmg;
      }
    } else {
      lavaAcc.current = 0;
      if (inWater || gs.worldMode !== 'survival' || effects.fireRes > 0) {
        fireAcc.current = 0;
        fireDmgAcc.current = 0;
      } else if (fireAcc.current > 0) {
        fireAcc.current -= dt;
        fireDmgAcc.current += dt;
        const fd = Math.floor(fireDmgAcc.current);
        if (fd > 0 && gs.damagePlayer(fd)) fireDmgAcc.current -= fd;
      }
    }
    // 着火状态桥：燃烧剩余秒数共享给屏幕火焰覆盖层（0 = 未燃烧；浸岩浆时 fireAcc 持续刷新为 15，出水/脱离危险递减）
    burningState.burningLeft = Math.max(0, fireAcc.current);
    // 虚空伤害（y < -20）：MC Java 每次受击 4 点、约 0.5s 一击（damagePlayer 的 HURT_COOLDOWN 无敌帧自然节流，等效 ~8/s），
    // bypassArmor 不吃护甲。死亡走正常死亡流程（掉落 + 死亡界面），不再传送回重生点
    if (p.y < -20 && !gs.dead) {
      voidAcc.current += dt * 8;
      const vd = Math.floor(voidAcc.current);
      if (vd > 0) {
        if (gs.worldMode === 'creative') {
          // MC Java：虚空伤害创造模式同样致死——damagePlayer 对创造直接豁免（return false），虚空路径在此绕过该门禁（Java 语义），
          // 借 hurtState 同款 500ms 无敌帧节流；创造死亡不掉落（MC：创造无背包惩罚），只进死亡界面
          const now = performance.now();
          if (now - hurtState.lastAt >= 500) {
            hurtState.lastAt = now;
            voidAcc.current -= vd;
            const health = Math.max(0, gs.health - vd);
            gs.setHealth(health);
            if (health <= 0) gs.setDead(true);
          }
        } else if (gs.damagePlayer(vd, { bypassArmor: true })) {
          voidAcc.current -= vd;
        }
      }
    } else {
      voidAcc.current = 0;
    }
    // 药水效果计时（创造模式也递减，MC 一致）
    tickEffects(dt);
    // 进食/饮用读条推进（MC Java 按住右键 1.61s/1.6s；取消/结算逻辑在 lib/actions.ts）
    tickEating(dt);
    // 弓拉弦状态桥：手持弓且按住使用键时每帧蓄力 0→1（MC Java 满弦 20 tick ≈ 1s），松手/换手持归 0；
    // 仅供 HeldItem 拉弦动画消费（射箭仍是右键即发的现有机制，本桥不影响伤害）
    {
      const heldBow = gs.hotbarSlots[gs.selectedSlot];
      bowState.draw = useButton.held && heldBow?.kind === 'tool' && heldBow.tool === 'bow' ? Math.min(1, bowState.draw + dt) : 0;
    }
    // 进食碎屑：读条中每 ~0.2s 从相机下方推出食物图标粒子（breakParticles 共享池；每帧位置由 fx/fz 前探；仅进食，饮用无碎屑——MC 喝水无粒子）
    if (eatState.active && eatState.kind === 'eat') {
      eatCrumbAcc.current += dt;
      if (eatCrumbAcc.current >= 0.2) {
        eatCrumbAcc.current = 0;
        breakParticles.push({
          x: camera.position.x + fx * 0.3 - 0.5,
          y: camera.position.y - 0.75,
          z: camera.position.z + fz * 0.3 - 0.5,
          tile: materialTile(eatState.material),
        });
      }
    } else {
      eatCrumbAcc.current = 0;
    }
    // 信标：校验金字塔并给范围内玩家刷新所选效果（MC）；节流到 0.5s 一次（lib/beacon.ts，MC Java 4s 重算）
    tickBeaconsThrottled(world, p.x, p.y, p.z, state.clock.elapsedTime);
    // 末影水晶：龙在存活水晶附近时缓慢回血（MC 治疗光束）。
    // 龙只存在于末地（mobs 按维度隔离，非末地 find 恒为 null）：非末地跳过查找；
    // 末地内缓存命中（includes 校验，O(n) 引用比较无闭包分配），被移除/重生成才重扫
    let dragon = cachedDragon.current;
    if (dragon !== null && !mobs.includes(dragon)) dragon = null;
    if (dragon === null && gs.dimension === 'end') dragon = mobs.find((m) => m.type === 'ender_dragon') ?? null;
    cachedDragon.current = dragon;
    tickCrystals(dragon, dt);
    // 钓鱼浮标：飞行/漂浮/咬钩推进
    tickFishing(world, dt);
    // 末影人对视激怒：准星盯上末影人即激怒（MC 规则，每秒检查一次）
    stareAcc.current += dt;
    if (stareAcc.current >= 1) {
      stareAcc.current = 0;
      const cam = cameraRef.current;
      if (cam) {
        // 视线方向复用本帧上方已算好的 rayDir（:591 camera.getWorldDirection），不再每帧分配 Vector3
        checkEndermanStare(world, cam.position.x, cam.position.y, cam.position.z, rayDir.x, rayDir.y, rayDir.z);
      }
    }

    // 打回的恶魂爆裂球：接近恶魂即秒杀（MC：反射火球对恶魂 1000 伤害）。
    // mobs 的通用玩家弹射物命中只有 9 伤且判定盒 0.55（恶魂 MC 体型 4×4×4），这里按体型放宽提前结算
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      if (a.kind !== 'ghast' || !a.fromPlayer) continue;
      const ghast = mobs.find((m) => m.type === 'ghast' && Math.hypot(m.x - a.x, m.y + 1.5 - a.y, m.z - a.z) < 3);
      if (ghast) {
        damageMob(ghast, 1000, playerPosition, 0, world);
        arrows.splice(i, 1);
      }
    }

    // 脚步声：着地行走时按实际位移触发（顶墙走不响）
    const hDist = Math.hypot(p.x - prevStep.current.x, p.z - prevStep.current.z);
    prevStep.current.x = p.x; // 字段直写，避免每帧对象字面量分配
    prevStep.current.z = p.z;
    // MC 消耗度：步行不消耗（MC Java），冲刺 0.1/格，游泳 0.01/格
    if (gs.worldMode === 'survival') {
      // 骑乘中不消耗（MC：骑乘移动不累加 exhaustion；hDist 此时是坐骑位移）
      survivalStats.exhaustion += hDist * (ridingNow ? 0 : inFluid ? 0.01 : sprinting ? 0.1 : 0);
    }
    if (!flying && !inFluid && onGround.current && hDist > 0.001) {
      stepAcc.current += hDist;
      if (stepAcc.current >= 2.2) {
        stepAcc.current = 0;
        const stepSound =
          BLOCKS[world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.01), Math.floor(p.z))]?.stepSound;
        if (stepSound) playSound(stepSound, 0.9);
      }
    } else {
      stepAcc.current = 0;
    }

    // 掉出世界底部不再传送回重生点：由上方虚空伤害致死（MC Java），死亡走正常死亡流程

    // 下界传送门：MC Java 生存站门内 4 秒（80 tick）触发跨维度传送，创造模式进立传（无读秒）
    // 骑乘中不触发传送门（坐骑不跨维度——mobs 切维度即销毁，传送会让骑乘引用悬空；也符合 MC 坐骑不进门的直觉）
    if (!ridingNow) {
      const feet = world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      const eye = world.getBlock(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z));
      // 折跃门：末地内接触即传送到外岛（MC；判定优先于返回门——折跃门中心也是 end_portal 方块）
      if (gs.dimension === 'end' && gatewayState.active) {
        const gd = Math.hypot(p.x - gatewayState.x, p.y + 0.5 - gatewayState.y, p.z - gatewayState.z);
        if (gd < 1.4) {
          const isle = pickOuterIsland(world.seedHash);
          if (isle) {
            p.x = isle.x + 0.5;
            p.y = outerHeightAt(world.seedHash, isle.x, isle.z) + 1;
            p.z = isle.z + 0.5;
            velY.current = 0;
            survivalMem.current.fallDist = 0;
            prevStep.current = { x: p.x, z: p.z };
            return;
          }
        }
      }
      // 末地传送门：接触即传送（MC 即时，无读秒）；主世界→末地落固定出生平台，末地→主世界回维度暂存位（MC 返回门）
      if (feet === BLOCK_BY_KEY.end_portal.id || eye === BLOCK_BY_KEY.end_portal.id) {
        if (gs.dimension === 'end') {
          teleportState.pending = { x: p.x, y: p.y, z: p.z, fromEnd: true };
          gs.setDimension('overworld');
        } else {
          teleportState.pending = { ...END_SPAWN };
          gs.setDimension('end');
        }
        return;
      }
      if (isPortalId(feet) || isPortalId(eye)) {
        portalAcc.current += dt;
        // 门内读秒进度（0-1）每帧共享给屏幕紫色渐进 overlay（MC 生存 4s = 80 tick 传满）
        portalState.charge = Math.min(1, portalAcc.current / 4);
        if (gs.worldMode === 'creative' || portalAcc.current >= 4) { // MC：生存读秒 4s（80 tick），创造秒传
          portalAcc.current = 0;
          teleportState.pending = { x: p.x, y: p.y, z: p.z };
          gs.setDimension(otherDimension(gs.dimension));
          return;
        }
      } else {
        portalAcc.current = 0;
        portalState.charge = 0;
      }
    }

    // 末影珍珠落点传送（mobs 命中写入，本帧消费）
    if (pearlTeleport.pending) {
      pos.current = { ...pearlTeleport.pending };
      pearlTeleport.pending = null;
      velY.current = 0;
      prevStep.current = { x: pos.current.x, z: pos.current.z };
    }

    // —— 相机反馈（MC Java 手感）：视角摆动 / 落地下顿 / 受伤倾斜 / 爆炸震动。帧循环零分配，全部直接改相机 ——
    const camPos = state.camera.position;
    camPos.set(p.x, p.y + (sprintSwim.current ? SWIM_EYE : sneaking ? EYE - 0.12 : EYE), p.z); // MC 潜行视点略降；俯泳视点 0.4（Java）
    // 视角摆动（view bobbing）：着地行走时相机周期上下+左右微晃；相位由水平位移驱动（每 1.6 格一周期），
    // 幅度随速度缩放（冲刺更明显、潜行减弱），空中/游泳/飞行时渐停
    const bobTarget =
      !flying && !inFluid && onGround.current && hDist > 0.001
        ? Math.min(speed / WALK_SPEED, 1.4) * (sneaking ? 0.35 : sprinting ? 1.25 : 1)
        : 0;
    bobAmp.current += (bobTarget - bobAmp.current) * Math.min(1, dt * 8);
    if (onGround.current && !flying && !inFluid) bobPhase.current += hDist * ((Math.PI * 2) / 1.6);
    if (bobAmp.current > 0.001) {
      const amp = bobAmp.current * 0.05; // 步幅基准 0.05：走路 ≈0.05，冲刺 ≈0.08，潜行几乎无感
      camPos.y += Math.abs(Math.sin(bobPhase.current)) * amp; // 上下每周期两晃
      const sway = Math.sin(bobPhase.current) * amp * 0.7; // 左右每周期一晃（右 = (-fz, fx)）
      camPos.x += -fz * sway;
      camPos.z += fx * sway;
    }
    // 落地短促下顿：sin 包络下顿后回弹（0.28s）
    if (landDip.current.t < 1) {
      landDip.current.t = Math.min(1, landDip.current.t + dt / 0.28);
      camPos.y -= landDip.current.amp * Math.sin(landDip.current.t * Math.PI);
    }
    // 受伤相机倾斜（MC Java damage tilt）：受击边沿触发随机侧 roll（~6.3°），0.4s 内二次方衰减回正
    const nowMs = performance.now();
    if (hurtState.lastAt > hurtSeen.current) {
      hurtSeen.current = hurtState.lastAt;
      hurtTilt.current.at = nowMs;
      hurtTilt.current.dir = Math.random() < 0.5 ? -1 : 1;
    }
    const tiltAge = (nowMs - hurtTilt.current.at) / 400;
    let roll = tiltAge < 1 ? hurtTilt.current.dir * 0.11 * (1 - tiltAge) * (1 - tiltAge) : 0;
    // 爆炸屏幕震动：cameraShake 包络内对位置/roll 加平滑伪噪声（两正弦叠加，衰减随 addShake 同款包络）
    const shakeAge = nowMs - cameraShake.at;
    if (shakeAge < SHAKE_DECAY_MS && cameraShake.mag > 0) {
      const k = cameraShake.mag * (1 - shakeAge / SHAKE_DECAY_MS);
      camPos.x += (Math.sin(nowMs * 0.0413) * 0.6 + Math.sin(nowMs * 0.0977) * 0.4) * k * 0.09;
      camPos.y += (Math.sin(nowMs * 0.0521 + 1.3) * 0.6 + Math.sin(nowMs * 0.0871 + 0.7) * 0.4) * k * 0.09;
      roll += (Math.sin(nowMs * 0.0631 + 2.1) * 0.6 + Math.sin(nowMs * 0.1103 + 4.2) * 0.4) * k * 0.05;
    }
    // roll 应用：delta 修正（桌面 mousemove 的四元数分解保留 z 分量；触屏帧首欧拉重建已回填 appliedRoll）
    state.camera.rotateZ(roll - appliedRoll.current);
    appliedRoll.current = roll;
    playerPosition.x = p.x;
    playerPosition.y = p.y;
    playerPosition.z = p.z;

    // 每帧一次的准星射线（rayDir 上面已算好），高亮/预览/挖掘共用；传入复用 out 避免命中时分配
    targetBlock.hit = raycastBlock(
      world,
      camera.position.x, camera.position.y, camera.position.z,
      rayDir.x, rayDir.y, rayDir.z,
      REACH,
      false,
      raycastHitOut,
    );

    // 长按/点按：优先攻击准星附近的生物（MC 1.9 攻击冷却），否则挖掘方块
    attackCd.current = Math.max(0, attackCd.current - dt);
    sprintBreak.current = Math.max(0, sprintBreak.current - dt);
    // 蓄力进度 → Hud 准星下方蓄力条（1 = 冷却走满，满时隐藏）
    attackState.progress = attackCd.current <= 0 ? 1 : Math.min(1, 1 - attackCd.current / attackCdTotal.current);
    const digNow = digHeld.current || touchInput.dig;
    // MC 1.9：冷却走满（含按住连发）满额出手；冷却未满时点按仍可出手，但伤害按冷却进度缩放
    const clickEdge = digNow && !digWasHeld.current;
    digWasHeld.current = digNow;
    if (digNow) {
      let attacked = false;
      // 近战攻击：创造模式也可（MC 创造左键可杀怪；伤害按手持，创造徒手 1 点，不耗耐久——damageHeldTool 创造已豁免）
      if (attackCd.current <= 0 || clickEdge) {
        // 恶魂爆裂球：挥击打回（MC 标志玩法）——沿视线掉头反飞，命中恶魂即秒杀（结算见下方每帧检查）
        const fb = fireballInReach(
          camera.position.x, camera.position.y, camera.position.z,
          rayDir.x, rayDir.y, rayDir.z,
          REACH,
        );
        if (fb) {
          attackCd.current = 0.25;
          attackCdTotal.current = 0.25;
          const sp = Math.hypot(fb.vx, fb.vy, fb.vz); // 保持原速，掉头飞向视线方向（MC 反射球）
          fb.vx = rayDir.x * sp;
          fb.vy = rayDir.y * sp;
          fb.vz = rayDir.z * sp;
          fb.age = 0; // 重置寿命，保证能飞回远处恶魂
          fb.fromPlayer = true; // 视为玩家弹射物：不再伤玩家、可命中生物（tickArrows 规则）
          playSound('dig_choppy', 0.8);
          survivalStats.exhaustion += 0.1; // MC：攻击消耗
          attacked = true;
        } else {
        const mob = mobInReach(
          world,
          camera.position.x, camera.position.y, camera.position.z,
          rayDir.x, rayDir.y, rayDir.z,
          REACH,
        );
        if (mob) {
          const held = gs.hotbarSlots[gs.selectedSlot];
          const tool = held?.kind === 'tool' ? TOOLS[held.tool] : null;
          const T = tool?.attackCd ?? 0.25; // 总冷却 = 1/攻速（MC 拳头 4，剑 1.6，斧 0.8-1.0）
          const fullCharge = attackCd.current <= 0; // 冷却全满（横扫判定用，须在重置冷却前捕获）
          // MC 1.9 冷却伤害缩放：0.2 + ((t+0.5)/T)²×0.8（t=冷却已走过时间；走满=1 满额）
          const cdScale = fullCharge ? 1 : attackCooldownScale(T - attackCd.current, T);
          attackCd.current = T;
          attackCdTotal.current = T;
          // MC 暴击：下落中（velY<0、不着地、非水中/飞行/滑翔）命中伤害 ×1.5
          const crit = velY.current < 0 && !onGround.current && !inFluid && !flying && !gliding;
          // MC 1.21 重锤 smash：手持重锤且下落 >1.5 格命中生物 → 分段额外伤害（含致密附魔加成，公式在 lib/xp.ts maceSmashBonus）。
          // 摔落距离用现成的 survivalMem.fallDist（tickSurvival 逐帧累计、着地清零，故 smash 只可能在空中触发）
          const isMace = held?.kind === 'tool' && held.tool === 'mace';
          const smashBonus = isMace ? maceSmashBonus(survivalMem.current.fallDist, held?.kind === 'tool' ? (held.ench?.density ?? 0) : 0) : 0;
          const smash = smashBonus > 0;
          // 击退：MC 近战命中本就有基础击退（怪会后退），击退附魔在此之上增强；原仅附魔才击退导致普通攻击打不动怪
          const kbEnch = held?.kind === 'tool' ? (held.ench?.knockback ?? 0) : 0;
          // MC 冲刺击退：冲刺中命中击退加成（约 3 格量级，≈ MC 击退 I），命中后中断冲刺
          let kb = kbEnch > 0 ? kbEnch : 0.3;
          if (sprinting) {
            kb += 0.5;
            sprintBreak.current = 0.3;
          }
          const baseDmg = (tool?.attackDamage ?? 1) + (held?.kind === 'tool' ? ((held.ench?.sharpness ?? 0) * 0.5 + ((held.ench?.sharpness ?? 0) > 0 ? 0.5 : 0)) : 0) + (effects.strength > 0 ? 3 * Math.max(effectLvls.strength, beaconTiers.get('strength') ?? 1) : 0); // 拳头 1 点（半心），锋利 +0.5×级+0.5（MC Java），力量药水 +3/级（MC）
          // smash 加成独立叠加：不吃冷却缩放、与暴击互斥（Java：smash 命中不再结算暴击）
          damageMob(mob, baseDmg * cdScale * (crit && !smash ? 1.5 : 1) + smashBonus, playerPosition, held?.kind === 'tool' ? (held.ench?.looting ?? 0) : 0, world, kb); // 抢夺加掉落
          // 暴击/smash 反馈：命中点推一簇亮色星状粒子（breakParticles 共享池；白雪贴图是池内最亮 tile）
          if (crit || smash) {
            breakParticles.push({ x: mob.x - 0.5, y: mob.y + 0.4, z: mob.z - 0.5, tile: tileOf('snow') });
          }
          if (smash) {
            // MC：smash 命中免除本次摔落伤害——重置摔落距离（Java 还重置下落+小弹跳，从简只做免摔伤）
            survivalMem.current.fallDist = 0;
            hurtSound(0.8); // 更沉的命中反馈（克制：仅 smash 叠加，普通命中仍是下方 dig_choppy）
          }
          // MC Java 横扫攻击：剑 + 冷却全满 + 非冲刺命中时，主目标周围 1 格内其他敌对生物各受 1 点横扫伤害
          if (tool?.kind === 'sword' && fullCharge && !sprinting) {
            sweepAround(mob, playerPosition, world);
            // 横扫反馈：沿挥击弧（面前 ±40°）推两簇白色粒子（绕 Y 轴旋转向量：x'=x·cos+z·sin, z'=-x·sin+z·cos）
            for (const a of SWEEP_ARC) {
              const c = Math.cos(a);
              const s = Math.sin(a);
              breakParticles.push({
                x: p.x + (fx * c + fz * s) * 1.2 - 0.5,
                y: p.y + 0.7,
                z: p.z + (-fx * s + fz * c) * 1.2 - 0.5,
                tile: tileOf('snow'),
              });
            }
          }
          if (tool) gs.damageHeldTool(tool.kind === 'sword' || tool.kind === 'mace' ? 1 : 2); // MC：剑/重锤耗 1，工具作武器耗 2
          playSound('dig_choppy', 0.8);
          survivalStats.exhaustion += 0.1; // MC：攻击消耗
          attacked = true;
        } else {
          // 末影水晶：准星指向且 reach 内 → 击爆（MC 近战可击毁）
          const c = crystalInReach(camera.position, rayDir, REACH);
          if (c) {
            attackCd.current = 0.25;
            attackCdTotal.current = 0.25;
            hitCrystal(c, world, playerPosition, (d) => {
              if (!gs.dead) gs.damagePlayer(d);
            });
            attacked = true;
          }
        }
        }
      }
      if (attacked) {
        if (!ridingNow) handSwing.at = performance.now(); // 攻击出手（命中生物/水晶/打回爆裂球）：播一次手部挥动（骑乘中抑制挥臂）
        digState.target = null;
        digState.progress = 0;
      } else {
        const hit = targetBlock.hit;
        if (hit) {
          if (clickEdge && !ridingNow) handSwing.at = performance.now(); // 点按到方块先挥一次（骑乘中抑制挥臂）；持续挖掘的往复挥动由 HeldItem 随 digState 驱动
          const [bx, by, bz] = hit.block;
          const t = digState.target;
          if (!t || t[0] !== bx || t[1] !== by || t[2] !== bz) {
            digState.target = [bx, by, bz];
            digState.progress = 0;
            digTapAcc.current = 0; // 换目标重置敲击音计时（新块从 0.25s 后开始敲）
          }
          const blockId = world.getBlock(bx, by, bz);
          if (BLOCKS[blockId]?.unbreakable) {
            // 基岩/强化深板岩：不可破坏（MC 规则），不显示裂纹进度
            digState.target = null;
            digState.progress = 0;
          } else if (gs.worldMode === 'creative') {
            // 创造模式：即时破坏（MC 一致），无挖掘计时；200ms 冷却避免按住左键 60 块/秒（触屏连点同路径生效）
            const now = performance.now();
            if (now - lastCreativeBreak.current >= 200) {
              lastCreativeBreak.current = now;
              breakBlock(world, bx, by, bz);
              if (!ridingNow) handSwing.at = now; // 创造即时破坏：按住连破按 200ms 冷却节奏持续挥动（骑乘中抑制挥臂）
            }
            digState.target = null;
            digState.progress = 0;
          } else {
            // MC 挖掘时间：工具类别匹配即按工具速度（与采掘层级无关）；需镐方块层级达标切硬度×1.5 基值（digTime×0.3）、
            // 不足保持 ×5 基值但仍除速度（层级只影响掉落）；效率附魔速度>1 生效，水中/悬空（onGround=false）各 ×5 慢（lib/dig.ts）
            const held = gs.hotbarSlots[gs.selectedSlot];
            digState.progress += dt / effectiveDigTime(blockId, held, effects.haste > 0 ? (beaconTiers.get('haste') ?? 1) : 0, headInWater, onGround.current);
            // 挖掘敲击音：长按过程中每 0.25s 低音量播该方块挖掘音组（MC 挖掘循环声；挖碎瞬间的全音量音效在 breakBlock）
            digTapAcc.current += dt;
            if (digTapAcc.current >= 0.25) {
              digTapAcc.current = 0;
              const tapSnd = BLOCKS[blockId]?.digSound;
              if (tapSnd) playSound(tapSnd, 0.25);
            }
            if (digState.progress >= 1) {
              breakBlock(world, bx, by, bz);
              if (gs.worldMode === 'survival') {
                survivalStats.exhaustion += 0.005; // MC：挖掘消耗
                // MC：剑挖方块固定耗 2 点耐久（SwordItem.mineBlock），其他工具 1 点；
                // 硬度 0 的瞬碎方块（花草/火把/树苗/红石粉等，digTime≤0.05）不耗耐久
                if (held?.kind === 'tool' && (BLOCKS[blockId]?.digTime ?? 1) > 0.05) {
                  gs.damageHeldTool(TOOLS[held.tool].kind === 'sword' ? 2 : 1);
                }
              }
              digState.target = null;
              digState.progress = 0;
            }
          }
        } else {
          digState.target = null;
          digState.progress = 0;
          // 挥空（准星无方块/生物）：MC 点击空气即挥臂；按住不动则按挥动动画时长（与 HeldItem SWING_MS 一致）节奏持续挥臂。骑乘中抑制挥臂
          if (!ridingNow && (clickEdge || nowMs - handSwing.at >= 250)) handSwing.at = nowMs;
        }
      }
    } else if (digState.target) {
      digState.target = null;
      digState.progress = 0;
    }
    if (!digState.target) digTapAcc.current = 0; // 挖掘中断（松键/移开准星/已挖碎/出手攻击）重置敲击计时

    // F3 调试数据
    debugInfo.fps = debugInfo.fps * 0.9 + (1 / Math.max(delta, 1e-4)) * 0.1;
    debugInfo.x = p.x;
    debugInfo.y = p.y;
    debugInfo.z = p.z;
    debugInfo.yaw = ((Math.atan2(-fx, -fz) * 180) / Math.PI + 360) % 360;
  });

  // 触屏模式不启用指针锁；桌面鼠标视角由上面的 mousemove 监听维护（组件本身只挂 effect，无渲染输出）
  return null;
}
