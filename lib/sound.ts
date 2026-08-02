// WebAudio 音效：按组随机变体 + 随机音调，懒加载解码，首次用户手势后自动恢复

import type { SoundGroup } from './blocks';
import { useGameStore } from './store';
import { withBase } from './basepath';

const GROUP_FILES: Record<SoundGroup, string[]> = {
  // 挖掘
  dig_cracky: ['default_dig_cracky.1.ogg', 'default_dig_cracky.2.ogg', 'default_dig_cracky.3.ogg'],
  dig_choppy: ['default_dig_choppy.1.ogg', 'default_dig_choppy.2.ogg', 'default_dig_choppy.3.ogg'],
  dig_glass: ['default_break_glass.1.ogg', 'default_break_glass.2.ogg', 'default_break_glass.3.ogg'],
  dig_dirt: ['default_dug_node.1.ogg', 'default_dug_node.2.ogg'],
  dig_leaves: ['default_grass_footstep.1.ogg', 'default_grass_footstep.2.ogg', 'default_grass_footstep.3.ogg'],
  // 放置
  place: ['default_place_node.1.ogg', 'default_place_node.2.ogg', 'default_place_node.3.ogg'],
  place_hard: ['default_place_node_hard.1.ogg', 'default_place_node_hard.2.ogg'],
  // 脚步
  step_grass: ['default_grass_footstep.1.ogg', 'default_grass_footstep.2.ogg', 'default_grass_footstep.3.ogg'],
  step_dirt: ['default_dirt_footstep.1.ogg', 'default_dirt_footstep.2.ogg'],
  step_sand: ['default_sand_footstep.1.ogg', 'default_sand_footstep.2.ogg', 'default_sand_footstep.3.ogg'],
  step_hard: ['default_hard_footstep.1.ogg', 'default_hard_footstep.2.ogg', 'default_hard_footstep.3.ogg'],
  step_wood: ['default_wood_footstep.1.ogg', 'default_wood_footstep.2.ogg'],
};

let ctx: AudioContext | null = null;
let preloadQueued = false;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** 是否已发生用户手势（浏览器自动播放策略：无手势创建/恢复 AudioContext 会刷警告） */
let gestured = typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === true;

function audioCtx(): AudioContext | null {
  if (!ctx) {
    if (!gestured) return null; // 等首次手势，由下方监听器创建
    ctx = new AudioContext();
  }
  // 浏览器要求用户手势后才能出声：每次播放都尝试恢复
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function loadBuffer(file: string): Promise<AudioBuffer> {
  let p = buffers.get(file);
  if (!p) {
    const ac = audioCtx();
    if (!ac) return Promise.reject(new Error('AudioContext 等待用户手势'));
    p = fetch(withBase(`/sounds/${file}`))
      .then((r) => {
        if (!r.ok) throw new Error(`音效缺失: ${file}`);
        return r.arrayBuffer();
      })
      .then((ab) => ac.decodeAudioData(ab));
    buffers.set(file, p);
    // 失败不缓存 rejection，下次播放时重试
    p.catch(() => buffers.delete(file));
  }
  return p;
}

function preloadAll(): void {
  for (const files of Object.values(GROUP_FILES)) {
    for (const f of files) void loadBuffer(f).catch(() => {});
  }
}

/** 世界加载后预载全部音效（静默失败，播放时会再尝试；无用户手势则推迟到首次手势） */
export function preloadSounds(): void {
  if (gestured) preloadAll();
  else preloadQueued = true;
}

export function boom(volume = 1): void {
  const ac = audioCtx();
  if (!ac) return;
  const dur = 0.7;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  const gain = ac.createGain();
  gain.gain.value = useGameStore.getState().settings.volume * volume;
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ac.destination);
  src.start();
}

export function playSound(group: SoundGroup, volume = 1): void {
  const files = GROUP_FILES[group];
  const file = files[(Math.random() * files.length) | 0];
  void loadBuffer(file)
    .then((buffer) => {
      const ac = audioCtx();
      if (!ac) return;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      // 每次播放随机音调，避免机械重复感
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const gain = ac.createGain();
      gain.gain.value = useGameStore.getState().settings.volume * volume;
      src.connect(gain);
      gain.connect(ac.destination);
      src.start();
    })
    .catch(() => {});
}

/** 音符盒音高：半音 0-24 → 频率 Hz（C4=261.63 起每半音 ×2^(1/12)，MC 音符盒 24 半音两八度循环） */
export function noteFreq(semitone: number): number {
  return 261.63 * Math.pow(2, semitone / 12);
}

/** 音符盒「叮」：正弦振荡器 + 指数衰减包络（合成音，同 boom 的 WebAudio 思路；无用户手势时静默） */
export function noteBlock(semitone: number, volume = 1): void {
  const ac = audioCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = noteFreq(semitone);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(useGameStore.getState().settings.volume * volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.6);
}

/** 单个振荡器音符：type/频率/起止时间/衰减（hurt/eat/levelup 的共用件，音量含全局设置与随机音高） */
function blip(type: OscillatorType, freq: number, at: number, dur: number, volume: number, freqEnd?: number): void {
  const ac = audioCtx();
  if (!ac) return;
  const p = 0.9 + Math.random() * 0.2; // 与 playSound 一致的随机音高，避免机械重复感
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * p, at);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(freqEnd * p, at + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(useGameStore.getState().settings.volume * volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(at);
  osc.stop(at + dur);
}

/** 受伤「咚」：三角波快速下滑短音（程序合成；public/sounds 无 hurt 素材）。音量克制，低于挖掘反馈 */
export function hurtSound(volume = 0.5): void {
  const ac = audioCtx();
  if (!ac) return;
  blip('triangle', 220, ac.currentTime, 0.18, volume, 90);
}

/** 打嗝「呃」：低频正弦短促下滑（程序合成；进食完成反馈，由 Hud 监听 lastAteAt 触发）。音量克制 */
export function burpSound(volume = 0.3): void {
  const ac = audioCtx();
  if (!ac) return;
  blip('sine', 150, ac.currentTime, 0.16, volume, 70);
}

/** 进食「嚼」：三连短促方波脉冲（程序合成；public/sounds 无 eat 素材） */
export function eatSound(volume = 0.4): void {
  const ac = audioCtx();
  if (!ac) return;
  for (let i = 0; i < 3; i++) blip('square', 160 + i * 30, ac.currentTime + i * 0.09, 0.06, volume);
}

/** 喝药「咕咚」：三连低频正弦下滑短音（程序合成，饮用读条反馈；public/sounds 无 drink 素材）。音量克制 */
export function glugSound(volume = 0.3): void {
  const ac = audioCtx();
  if (!ac) return;
  for (let i = 0; i < 3; i++) blip('sine', 150 - i * 25, ac.currentTime + i * 0.11, 0.08, volume, 70);
}

/** 升级「叮-叮-叮-叮」：C5 起上行琶音（程序合成，MC 升级钟声观感；public/sounds 无 levelup 素材） */
export function levelupSound(volume = 0.5): void {
  const ac = audioCtx();
  if (!ac) return;
  const semis = [12, 16, 19, 24]; // C5 E5 G5 C6
  for (let i = 0; i < semis.length; i++) blip('sine', noteFreq(semis[i]), ac.currentTime + i * 0.1, 0.5, volume);
}

// ——— 经验球拾取「叮」：1s 窗口内连续拾取音调渐升（Java 手感），窗口外重置 ———
let xpPickupCount = 0;
let xpPickupLastAt = 0;

/** 连续拾取升调倍率：第 n 次 ×1.06^n（封顶 1.9 避免刺耳）；纯函数可测 */
export function xpPickupPitch(count: number): number {
  return Math.min(1.9, Math.pow(1.06, Math.max(0, count)));
}

/** 经验球拾取「叮」：短促高音 sine（0.15s），按最近 1s 内拾取计数升调（XpOrbs 拾取回调触发） */
export function xpPickupSound(volume = 0.35): void {
  const ac = audioCtx();
  if (!ac) return;
  const now = performance.now();
  xpPickupCount = now - xpPickupLastAt > 1000 ? 0 : xpPickupCount + 1;
  xpPickupLastAt = now;
  blip('sine', 1320 * xpPickupPitch(xpPickupCount), ac.currentTime, 0.15, volume);
}

/** 雷声：低频棕噪声轰隆 + 两次回滚滚雷，低通随时间收紧（程序合成，MC 远雷观感）。
 *  volume 由调用方按落点距离折算（lightning.ts：近 1.0 远 0.15，超出可闻距离只闪不炸） */
export function thunder(volume = 1): void {
  const ac = audioCtx();
  if (!ac) return;
  const dur = 3.2;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    // 棕噪声（低频轰鸣）；包络 = 主轰隆快衰减 + 两次高斯回滚（滚雷）
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    const envelope = Math.pow(1 - t, 1.6) + 0.5 * Math.exp(-(((t - 0.35) * 6) ** 2)) + 0.3 * Math.exp(-(((t - 0.65) * 7) ** 2));
    data[i] = last * 8 * envelope;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(320, ac.currentTime);
  lp.frequency.exponentialRampToValueAtTime(70, ac.currentTime + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(useGameStore.getState().settings.volume * volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ac.destination);
  src.start();
}

/** 水花「扑通」：高频噪声短 burst，低通随时间收紧（程序合成，0.2s；钓鱼咬钩/抛竿落水反馈）。音量克制 */
export function splashSound(volume = 0.35): void {
  const ac = audioCtx();
  if (!ac) return;
  const dur = 0.2;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.8);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3200, ac.currentTime);
  lp.frequency.exponentialRampToValueAtTime(600, ac.currentTime + dur);
  const gain = ac.createGain();
  gain.gain.value = useGameStore.getState().settings.volume * volume;
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ac.destination);
  src.start();
}

/** 箱盖开启「哒-沙」：低频木质哒声（三角波快速下滑）+ 轻摩擦噪声 burst（低通收紧，同 splash 的噪声件思路）。
 *  箱子/木桶面板打开时由 setStorageOpen 触发（Java 只有这两类容器有声，熔炉/酿造等无声）。音量克制 */
export function chestOpenSound(volume = 0.4): void {
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  blip('triangle', 150, now, 0.12, volume, 80); // 木质哒声
  // 箱盖掀起的轻摩擦感：短噪声 burst，低通随时间收紧
  const dur = 0.14;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.8);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, now);
  lp.frequency.exponentialRampToValueAtTime(250, now + dur);
  const gain = ac.createGain();
  gain.gain.value = useGameStore.getState().settings.volume * volume * 0.5; // 摩擦声低于哒声
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ac.destination);
  src.start();
}

/** 箱盖合上：更轻更短的木质哒声（无摩擦；Java 关盖声明显轻于开盖） */
export function chestCloseSound(volume = 0.28): void {
  const ac = audioCtx();
  if (!ac) return;
  blip('triangle', 130, ac.currentTime, 0.09, volume, 70);
}

/** 铁砧「铿」：高频金属击声 + 非整数比泛音（金属感来源）+ 短余振（程序合成；铁砧修复/附魔合并完成时播）。音量克制 */
export function anvilSound(volume = 0.35): void {
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  blip('square', 1250, now, 0.14, volume * 0.6); // 金属「铿」主体
  blip('square', 1250 * 2.76, now, 0.08, volume * 0.3); // 泛音：非整数倍频 → 金属声
  blip('sine', 1250, now + 0.02, 0.3, volume * 0.25); // 短余振
}

// ——— 雨声环境音（程序合成：滤白噪声循环 buffer，start/stop 带音量渐变；Rain.tsx 按天气驱动） ———
let rainSrc: AudioBufferSourceNode | null = null;
let rainGain: GainNode | null = null;
let rainBuf: AudioBuffer | null = null;
/** 雨声基准音量（克制：环境底噪，远低于动作反馈音） */
const RAIN_BASE_VOLUME = 0.16;

/** 2s 循环雨声 buffer：轻度棕化的白噪声（密集雨点沙沙声），首尾交叉淡化消除循环咔哒 */
function rainBuffer(ac: AudioContext): AudioBuffer {
  if (rainBuf && rainBuf.sampleRate === ac.sampleRate) return rainBuf;
  const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = last * 0.94 + white * 0.06;
    data[i] = (white * 0.45 + last * 5) * 0.5;
  }
  const fade = Math.floor(ac.sampleRate * 0.01);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = data[i] * t + data[data.length - fade + i] * (1 - t);
  }
  rainBuf = buf;
  return buf;
}

/** 雨声开/调强度：未播则淡入启动，已在播则渐变到新强度（intensity 1=普通雨，雷暴略大、雪天极轻）。幂等，可每帧调用 */
export function startRain(intensity = 1): void {
  const ac = audioCtx();
  if (!ac) return;
  const target = useGameStore.getState().settings.volume * RAIN_BASE_VOLUME * intensity;
  if (rainSrc && rainGain) {
    rainGain.gain.setTargetAtTime(target, ac.currentTime, 0.5);
    return;
  }
  const src = ac.createBufferSource();
  src.buffer = rainBuffer(ac);
  src.loop = true;
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2600; // 闷一点的环境沙沙声
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, ac.currentTime);
  gain.gain.setTargetAtTime(target, ac.currentTime, 1.2); // 淡入
  src.connect(lp);
  lp.connect(gain);
  gain.connect(ac.destination);
  src.start();
  rainSrc = src;
  rainGain = gain;
  src.onended = () => {
    // 手动 stop 或意外结束都会触发：仅当仍指向自己时清状态（避免清掉期间新开的雨）
    if (rainSrc === src) {
      rainSrc = null;
      rainGain = null;
    }
    src.disconnect();
    lp.disconnect();
    gain.disconnect();
  };
}

/** 雨声停：淡出后停源（转晴/雪天/入水/组件卸载调用）。幂等；淡出期间重开由 startRain 新建源 */
export function stopRain(): void {
  const src = rainSrc;
  const gain = rainGain;
  rainSrc = null;
  rainGain = null;
  if (!ctx || !src || !gain) return;
  gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4); // 淡出
  try {
    src.stop(ctx.currentTime + 1.5);
  } catch {
    /* 源已停：忽略 */
  }
}
if (typeof window !== 'undefined') {
  const onGesture = () => {
    gestured = true;
    audioCtx();
    if (preloadQueued) {
      preloadQueued = false;
      preloadAll();
    }
  };
  window.addEventListener('pointerdown', onGesture, { once: true });
  window.addEventListener('keydown', onGesture, { once: true });
}
