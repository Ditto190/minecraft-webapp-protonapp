// UI 反馈音接线：容器（箱子/木桶）开合经 setStorageOpen 播箱盖声（开有声、关更轻、空关不出声）；
// 铁砧 anvilUse 成功（修复/附魔合并）播铿锵声、失败不播。合成音实现本身见 sound.test.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sound', () => ({
  boom: vi.fn(),
  playSound: vi.fn(),
  preloadSounds: vi.fn(),
  noteFreq: (n: number) => 261.63 * Math.pow(2, n / 12),
  noteBlock: vi.fn(),
  hurtSound: vi.fn(),
  burpSound: vi.fn(),
  eatSound: vi.fn(),
  levelupSound: vi.fn(),
  xpPickupPitch: (count: number) => Math.min(1.9, Math.pow(1.06, Math.max(0, count))),
  xpPickupSound: vi.fn(),
  thunder: vi.fn(),
  splashSound: vi.fn(),
  chestOpenSound: vi.fn(),
  chestCloseSound: vi.fn(),
  anvilSound: vi.fn(),
  startRain: vi.fn(),
  stopRain: vi.fn(),
}));

import { emptySlots, type Slot } from '../slots';
import { anvilSound, chestCloseSound, chestOpenSound } from '../sound';
import { useGameStore } from '../store';

const mockChestOpen = vi.mocked(chestOpenSound);
const mockChestClose = vi.mocked(chestCloseSound);
const mockAnvil = vi.mocked(anvilSound);

beforeEach(() => {
  vi.clearAllMocks();
  useGameStore.setState({
    worldMode: 'survival',
    hotbarSlots: emptySlots(),
    mainSlots: Array.from({ length: 27 }, () => null) as Slot[],
    selectedSlot: 0,
    notice: null,
    storageOpen: null,
    xpTotal: 10000, // 铁砧操作默认经验充足
  });
});

describe('容器开合音（箱子/木桶共用 setStorageOpen 路径）', () => {
  it('打开容器播箱盖开启声，关闭播更轻的关合声', () => {
    useGameStore.getState().setStorageOpen('1,2,3');
    expect(mockChestOpen).toHaveBeenCalledTimes(1);
    expect(mockChestClose).not.toHaveBeenCalled();
    useGameStore.getState().setStorageOpen(null);
    expect(mockChestClose).toHaveBeenCalledTimes(1);
    expect(mockChestOpen).toHaveBeenCalledTimes(1);
  });

  it('空关（未开时关）不出声；连续开两箱各播一次', () => {
    useGameStore.getState().setStorageOpen(null); // 本来就关着：守卫
    expect(mockChestClose).not.toHaveBeenCalled();
    useGameStore.getState().setStorageOpen('1,2,3');
    useGameStore.getState().setStorageOpen('4,5,6'); // 换箱直接开：仍是开
    expect(mockChestOpen).toHaveBeenCalledTimes(2);
    expect(mockChestClose).not.toHaveBeenCalled();
  });
});

describe('铁砧使用音（修复/附魔合并完成）', () => {
  it('修复成功播铿锵声', () => {
    const slots = emptySlots();
    slots[0] = { kind: 'tool', tool: 'diamond_sword', durability: 100 };
    slots[3] = { kind: 'material', material: 'diamond', count: 1 };
    useGameStore.setState({ hotbarSlots: slots, selectedSlot: 0 });
    expect(useGameStore.getState().anvilUse().ok).toBe(true);
    expect(mockAnvil).toHaveBeenCalledTimes(1);
  });

  it('附魔合并成功播铿锵声', () => {
    const slots = emptySlots();
    slots[0] = { kind: 'tool', tool: 'diamond_sword', durability: 500, ench: { sharpness: 2 } };
    slots[5] = { kind: 'tool', tool: 'diamond_sword', durability: 300, ench: { sharpness: 2 } };
    useGameStore.setState({ hotbarSlots: slots, selectedSlot: 0 });
    expect(useGameStore.getState().anvilUse().ok).toBe(true);
    expect(mockAnvil).toHaveBeenCalledTimes(1);
  });

  it('失败（空手/满耐久/缺材料/经验不足）不播', () => {
    expect(useGameStore.getState().anvilUse().ok).toBe(false); // 空手
    const slots = emptySlots();
    slots[0] = { kind: 'tool', tool: 'iron_pickaxe', durability: 100 };
    useGameStore.setState({ hotbarSlots: slots, selectedSlot: 0 });
    expect(useGameStore.getState().anvilUse().ok).toBe(false); // 缺材料
    expect(mockAnvil).not.toHaveBeenCalled();
  });
});
