// 音符盒合成音：音高函数（C4 基准、八度倍频、半音等比）与无手势环境静默安全

import { describe, expect, it } from 'vitest';
import {
  anvilSound,
  burpSound,
  chestCloseSound,
  chestOpenSound,
  eatSound,
  glugSound,
  hurtSound,
  levelupSound,
  noteBlock,
  noteFreq,
  splashSound,
  startRain,
  stopRain,
  xpPickupPitch,
  xpPickupSound,
} from '../sound';

describe('音符盒音高', () => {
  it('C4=261.63Hz 基准；12 半音翻倍（C5），24 半音四倍（C6）', () => {
    expect(noteFreq(0)).toBeCloseTo(261.63, 2);
    expect(noteFreq(12)).toBeCloseTo(261.63 * 2, 1);
    expect(noteFreq(24)).toBeCloseTo(261.63 * 4, 1);
  });

  it('半音等比：相邻半音比 2^(1/12)；9 半音到 A4=440Hz', () => {
    expect(noteFreq(1) / noteFreq(0)).toBeCloseTo(Math.pow(2, 1 / 12), 5);
    expect(noteFreq(9)).toBeCloseTo(440, 0);
    expect(noteFreq(4)).toBeCloseTo(329.63, 1); // E4
  });

  it('无 AudioContext（无用户手势/非浏览器）时静默不抛错', () => {
    expect(() => noteBlock(0)).not.toThrow();
    expect(() => noteBlock(23)).not.toThrow();
  });
});

describe('受伤/进食/饮用/升级合成音效', () => {
  it('无 AudioContext（无用户手势/非浏览器）时静默不抛错', () => {
    expect(() => hurtSound()).not.toThrow();
    expect(() => eatSound()).not.toThrow();
    expect(() => glugSound()).not.toThrow();
    expect(() => levelupSound()).not.toThrow();
  });
});

describe('经验球拾取升调（xpPickupPitch）', () => {
  it('第 0 次为基准 1，连续拾取 ×1.06 渐升', () => {
    expect(xpPickupPitch(0)).toBe(1);
    expect(xpPickupPitch(1)).toBeCloseTo(1.06, 5);
    expect(xpPickupPitch(2)).toBeCloseTo(1.06 * 1.06, 5);
  });

  it('单调不减且封顶 1.9；负计数钳到基准', () => {
    let prev = 0;
    for (let n = 0; n < 12; n++) {
      const p = xpPickupPitch(n);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(xpPickupPitch(100)).toBe(1.9); // 封顶
    expect(xpPickupPitch(-3)).toBe(1);
  });
});

describe('打嗝/水花/拾取叮/雨声循环', () => {
  it('无 AudioContext（无用户手势/非浏览器）时静默不抛错', () => {
    expect(() => burpSound()).not.toThrow();
    expect(() => splashSound()).not.toThrow();
    expect(() => xpPickupSound()).not.toThrow();
    expect(() => startRain()).not.toThrow();
    expect(() => startRain(1.5)).not.toThrow(); // 雷暴强度
    expect(() => stopRain()).not.toThrow();
    expect(() => stopRain()).not.toThrow(); // 幂等
  });
});

describe('箱盖开合/铁砧合成音效', () => {
  it('无 AudioContext（无用户手势/非浏览器）时静默不抛错', () => {
    expect(() => chestOpenSound()).not.toThrow();
    expect(() => chestCloseSound()).not.toThrow();
    expect(() => anvilSound()).not.toThrow();
  });
});
