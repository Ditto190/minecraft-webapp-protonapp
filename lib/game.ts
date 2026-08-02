// 游戏运行时单例（非 React 响应式）：当前世界 + 玩家位置 + 相机 + 触屏输入

import type { Camera } from 'three';
import type { RaycastHit } from './raycast';
import type { World } from './world';

let activeWorld: World | null = null;

export function setActiveWorld(world: World | null): void {
  activeWorld = world;
}

export function getActiveWorld(): World | null {
  return activeWorld;
}

/** 玩家脚底位置，Player 每帧写入，WorldRenderer 读取用于 chunk 调度 */
export const playerPosition = { x: 8.5, y: 40, z: 8.5 };

/** 跨维度传送：Player 站在门内写入待传送坐标，WorldRenderer 切换维度后消费；fromEnd = 末地返回主世界（回维度暂存位，不造门） */
export const teleportState: { pending: ({ x: number; y: number; z: number } & { fromEnd?: boolean }) | null } = { pending: null };

/** 末影珍珠落点传送：mobs 命中写入，Player 下帧消费（瞬移 + 清空） */
export const pearlTeleport: { pending: { x: number; y: number; z: number } | null } = { pending: null };

/** Boss 血条状态（凋灵存活且在玩家附近时由 tickMobs 刷新，Hud 显示；无 Boss 时 name 为空） */
export const bossState = { name: '', hp: 0, max: 300 };

/** 当前相机，Player 挂载时写入，供触屏按钮执行挖/放 */
export const cameraRef: { current: Camera | null } = { current: null };

/** 触屏输入，TouchControls 写入，Player 每帧读取 */
export const touchInput = {
  /** 摇杆：x 右为正，y 前为正，范围 [-1, 1]（模拟量，保留力度） */
  moveX: 0,
  moveY: 0,
  /** 视角拖动增量（像素），Player 消费后清零 */
  lookDX: 0,
  lookDY: 0,
  jump: false,
  down: false,
  /** 按住「挖」按钮 */
  dig: false,
  /** 潜行开关（TouchControls 切换按钮；Player 与桌面 Shift 合并消费） */
  sneak: false,
  /** 冲刺开关（TouchControls 切换按钮；Player 与桌面 Ctrl 合并消费） */
  sprint: false,
};

/** 长按挖掘进度，Player 每帧写入，CrackOverlay 读取 */
export const digState = {
  target: null as [number, number, number] | null,
  /** 0..1，达到 1 时破坏方块 */
  progress: 0,
};

/** 攻击冷却蓄力进度（MC 1.9 战斗）：Player 每帧写入（1 = 冷却走满可满额出手），Hud 准星下方蓄力条读取 */
export const attackState = { progress: 1 };

export interface BreakParticleEvent {
  x: number;
  y: number;
  z: number;
  /** atlas tile 索引（粒子贴图取该方块侧面） */
  tile: number;
}

/** 当前天空色（DayNight 每帧写入，UnderwaterFX 出水恢复时读取） */
export const atmosphere = { r: 0.53, g: 0.81, b: 0.92 };

/** 昼夜时钟（0=日出 0.25=正午 0.5=日落 0.75=午夜），DayNight 推进，随存档持久化 */
export const worldClock = { t: 0.3 };

/** 与 DayNight 一致的昼夜系数：1 白天，0 黑夜，日出日落平滑过渡 */
export function dayFactorAt(t: number): number {
  const e = Math.sin(t * Math.PI * 2);
  const x = Math.min(Math.max((e + 0.12) / 0.27, 0), 1);
  return x * x * (3 - 2 * x);
}

/** 受击无敌帧（伤害冷却），damagePlayer 判定用；负无穷表示从未受伤 */
export const hurtState = { lastAt: Number.NEGATIVE_INFINITY };

/** 相机震动（爆炸等冲击源）：addShake 写入，Player 帧循环消费成衰减噪声偏移 */
export const cameraShake = { mag: 0, at: 0 };

/** 震动包络时长（ms）：从 at 起线性衰减到 0（Player 消费同款包络） */
export const SHAKE_DECAY_MS = 600;

/** 叠加一次相机震动：旧震动先按包络折损再累加，封顶 1（连续爆炸不会越叠越猛） */
export function addShake(mag: number): void {
  const now = performance.now();
  const left = cameraShake.mag * Math.max(0, 1 - (now - cameraShake.at) / SHAKE_DECAY_MS);
  cameraShake.mag = Math.min(1, left + mag);
  cameraShake.at = now;
}

/** 进食反馈钩子：最近一次吃完的时间戳（actions.finishEating 写入；Hud 订阅用于播打嗝声） */
export const eatFeedback = { lastAteAt: 0 };

/** 手部挥动钩子：攻击命中/挥空与放置成功时 Player 写入时间戳（performance.now），HeldItem 读时间戳播挥动动画（松耦合，同 eatFeedback 模式） */
export const handSwing = { at: 0 };

/** 传送门读秒状态桥：Player 门内读秒每帧写入 0-1 进度（不在门内/死亡/换维度归 0），屏幕紫色渐进 overlay 消费 */
export const portalState = { charge: 0 };

/** 着火状态桥：玩家正在燃烧的剩余秒数（Player 着火逻辑每帧写入；屏幕火焰覆盖层消费，0 = 未燃烧） */
export const burningState = { burningLeft: 0 };

/** 生存模式消耗度（MC exhaustion）：满 4 消耗 1 点饱和度/饥饿；wither 凋零 DoT 剩余秒；air 氧气剩余秒（HUD 气泡条，Player 每帧镜像自 survivalMem） */
export const survivalStats = { exhaustion: 0, wither: 0, air: 15 };

/** 每帧一次的准星射线结果：Player 计算，BlockHighlight / PlacePreview / 挖掘共用 */
export const targetBlock: { hit: RaycastHit | null } = { hit: null };

/** 方块破坏粒子事件队列，actions 写入，BreakParticles 每帧消费 */
export const breakParticles: BreakParticleEvent[] = [];

/** 因打开面板而主动退出指针锁的标记：store-panels 打开面板时写入，Player 在面板全关后消费。
 * 区分「面板退锁」与「用户主动 Esc 暂停」——仅前者在面板全关后自动回锁（用户 Esc 仍出暂停遮罩） */
export const panelUnlock = { pending: false };

/** 加载阶段（GameCanvas 写入，page.tsx LoadingOverlay 轮询显示）：detect = 渲染器检测中，world = 世界生成中（进度读 debugInfo.chunks） */
export const loadingState = { phase: 'detect' as 'detect' | 'world' };

/** F3 调试面板的共享数据，Player / WorldRenderer / BlockHighlight 每帧写入 */
export const debugInfo = {
  fps: 0,
  x: 0,
  y: 0,
  z: 0,
  /** 水平朝向角（度，0 = -z） */
  yaw: 0,
  chunks: 0,
  dirty: 0,
  /** 游戏内时刻（0-23 点），DayNight 写入 */
  hour: 12,
  /** 准星目标方块描述，无目标为空串 */
  target: '',
};
