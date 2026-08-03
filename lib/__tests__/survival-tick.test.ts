import { beforeEach, describe, expect, it } from 'vitest';
import { clearEffects, effectLvls, effects } from '../effects';
import { survivalStats } from '../game';
import { resetSurvivalMem, tickSurvival, type SurvivalMem } from '../survival';

function makeMem(): SurvivalMem {
  return { fallDist: 0, air: 15, regenTick: 0, witherTick: 0, regenPotionTick: 0 };
}

const ENV = {
  dt: 0.5,
  flying: false,
  inWater: false,
  headInWater: false,
  onGround: true,
  velY: 0,
};

describe('生存数值 tick', () => {
  beforeEach(() => {
    survivalStats.exhaustion = 0;
    clearEffects();
  });

  it('掉落 4 格着地掉 1 点血（MC: floor(4-3)）', () => {
    const mem = makeMem();
    const dmg: number[] = [];
    // 先累计 4 格下落
    tickSurvival({ ...ENV, onGround: false, velY: -4 }, mem, { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 }, { damagePlayer: (a) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} });
    mem.fallDist = 4; // 直接置累计值验证结算
    tickSurvival({ ...ENV, onGround: true }, mem, { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 }, { damagePlayer: (a) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} });
    expect(dmg).toEqual([1]);
    expect(mem.fallDist).toBe(0);
  });

  it('摔落/溺水/凋零伤害均带 bypassArmor（MC：不被护甲减免）', () => {
    const calls: { amount: number; bypass?: boolean }[] = [];
    const actions = {
      damagePlayer: (a: number, o?: { bypassArmor?: boolean }) => calls.push({ amount: a, bypass: o?.bypassArmor }),
      setHealth: () => {},
      setHunger: () => {},
      setSaturation: () => {},
    };
    const s = { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 };
    // 摔落
    const mem = makeMem();
    mem.fallDist = 6;
    tickSurvival({ ...ENV, onGround: true }, mem, s, actions);
    // 溺水（氧气耗尽）
    mem.air = 0.3;
    tickSurvival({ ...ENV, headInWater: true, onGround: false }, mem, s, actions);
    // 凋零 DOT
    survivalStats.wither = 1;
    tickSurvival({ ...ENV, dt: 1 }, mem, s, actions);
    survivalStats.wither = 0;
    expect(calls).toEqual([
      { amount: 3, bypass: true },
      { amount: 2, bypass: true },
      { amount: 1, bypass: true },
    ]);
  });

  it('创造模式跳过所有生存结算', () => {
    const mem = makeMem();
    mem.fallDist = 10;
    const dmg: number[] = [];
    tickSurvival(ENV, mem, { worldMode: 'creative', health: 20, hunger: 20, saturation: 5 }, { damagePlayer: (a) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} });
    expect(dmg.length).toBe(0);
    expect(mem.fallDist).toBe(10); // 未触碰
  });

  it('溺水：15 秒氧气耗尽后每秒 2 点伤害', () => {
    const mem = makeMem();
    const dmg: number[] = [];
    const actions = { damagePlayer: (a: number) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} };
    const s = { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 };
    // 15 秒水下
    for (let i = 0; i < 29; i++) tickSurvival({ ...ENV, headInWater: true, onGround: false }, mem, s, actions);
    expect(dmg.length).toBe(0);
    tickSurvival({ ...ENV, headInWater: true, onGround: false }, mem, s, actions);
    expect(dmg).toEqual([2]);
    expect(mem.air).toBe(1);
  });

  it('水肺效果：水下不耗氧气（MC 水肺药水）', () => {
    const mem = makeMem();
    const dmg: number[] = [];
    const actions = { damagePlayer: (a: number) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} };
    const s = { worldMode: 'survival', health: 20, hunger: 10, saturation: 0 };
    effects.waterBreath = 60;
    for (let i = 0; i < 40; i++) tickSurvival({ ...ENV, headInWater: true, onGround: false }, mem, s, actions);
    expect(mem.air).toBe(15); // 氧气满格不消耗
    expect(dmg.length).toBe(0);
    // 效果结束：恢复正常耗氧
    effects.waterBreath = 0;
    tickSurvival({ ...ENV, headInWater: true, onGround: false }, mem, s, actions);
    expect(mem.air).toBeLessThan(15);
  });

  it('再生 II：每 1.25 秒回 1 点（I 级每 2.5 秒，MC 25/50 tick）', () => {
    const mem = makeMem();
    const hp: number[] = [];
    const actions = { damagePlayer: () => {}, setHealth: (v: number) => hp.push(v), setHunger: () => {}, setSaturation: () => {} };
    // 饥饿 10：不触发自然回血，只统计药水再生
    const s = { worldMode: 'survival', health: 10, hunger: 10, saturation: 0 };
    effects.regen = 30;
    effectLvls.regen = 2;
    for (let i = 0; i < 20; i++) tickSurvival({ ...ENV, dt: 0.25 }, mem, s, actions); // 5 秒
    expect(hp.length).toBe(4); // II 级 1.25s/点 → 5 秒 4 点
    // 对照 I 级：2.5s/点 → 5 秒 2 点
    const mem2 = makeMem();
    const hp2: number[] = [];
    clearEffects();
    effects.regen = 30;
    for (let i = 0; i < 20; i++) tickSurvival({ ...ENV, dt: 0.25 }, mem2, s, { ...actions, setHealth: (v: number) => hp2.push(v) });
    expect(hp2.length).toBe(2);
  });

  it('消耗度满 4 先扣饱和度，耗尽后扣饥饿', () => {
    const mem = makeMem();
    const sat: number[] = [];
    const hun: number[] = [];
    const actions = {
      damagePlayer: () => {},
      setHealth: () => {},
      setHunger: (v: number) => hun.push(v),
      setSaturation: (v: number) => sat.push(v),
    };
    survivalStats.exhaustion = 4;
    tickSurvival(ENV, mem, { worldMode: 'survival', health: 20, hunger: 20, saturation: 2 }, actions);
    expect(sat).toEqual([1]);
    expect(survivalStats.exhaustion).toBe(0);
    // 饱和度 0 时扣饥饿
    survivalStats.exhaustion = 4;
    tickSurvival(ENV, mem, { worldMode: 'survival', health: 20, hunger: 20, saturation: 0 }, actions);
    expect(hun).toEqual([19]);
  });

  it('满饥饿且有饱和度时快速回血并消耗能量', () => {
    const mem = makeMem();
    const hp: number[] = [];
    const actions = { damagePlayer: () => {}, setHealth: (v: number) => hp.push(v), setHunger: () => {}, setSaturation: () => {} };
    tickSurvival({ ...ENV, dt: 0.6 }, mem, { worldMode: 'survival', health: 15, hunger: 20, saturation: 3 }, actions);
    expect(hp).toEqual([16]);
    expect(survivalStats.exhaustion).toBe(6);
  });

  it('resetSurvivalMem 重置全部记忆', () => {
    const mem = makeMem();
    mem.fallDist = 8;
    mem.air = 3;
    mem.regenTick = 2;
    resetSurvivalMem(mem);
    expect(mem).toEqual({ fallDist: 0, air: 15, regenTick: 0, witherTick: 0, regenPotionTick: 0 });
  });

  it('藤蔓攀爬：攀爬中不累计下落距离，抓住藤蔓清零既有下落（MC Java 攀爬免摔伤）', () => {
    const mem = makeMem();
    const dmg: number[] = [];
    const actions = { damagePlayer: (a: number) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} };
    const s = { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 };
    // 高处坠落 8 格后抓住藤蔓（climbing）：既有 fallDist 清零
    mem.fallDist = 8;
    tickSurvival({ ...ENV, onGround: false, velY: -4, climbing: true }, mem, s, actions);
    expect(mem.fallDist).toBe(0);
    // 攀爬中继续贴着藤蔓下滑/悬停：不累计下落距离
    tickSurvival({ ...ENV, onGround: false, velY: -1, climbing: true }, mem, s, actions);
    expect(mem.fallDist).toBe(0);
    // 松手落地（不再攀爬）：按清零后的距离结算，无摔落伤害
    tickSurvival({ ...ENV, onGround: true, velY: 0, climbing: false }, mem, s, actions);
    expect(dmg).toEqual([]);
  });

  it('藤蔓攀爬：攀爬中落地不受摔落伤害（climbing 优先于着地结算）', () => {
    const mem = makeMem();
    mem.fallDist = 10;
    const dmg: number[] = [];
    const actions = { damagePlayer: (a: number) => dmg.push(a), setHealth: () => {}, setHunger: () => {}, setSaturation: () => {} };
    const s = { worldMode: 'survival', health: 20, hunger: 20, saturation: 5 };
    // 踩着地面但仍贴藤（如藤格落地）：按攀爬处理清零，不吃 10 格摔落伤害
    tickSurvival({ ...ENV, onGround: true, climbing: true }, mem, s, actions);
    expect(dmg).toEqual([]);
    expect(mem.fallDist).toBe(0);
  });
});
