// GUI 快捷键与 Q 丢弃（Java 规则）store 集成测试：
// dropSelected（世界内 Q：1 个 / Ctrl+Q 整组 / 空手持不丢 / 2s 拾取延迟 / 面前生成）、
// dropSlot（GUI 悬停 Q）、swapWithHotbar（悬停 1-9 整组交换）、closePanels（E 关界面）、hudHidden（F1）。
// 纯函数 swapSlots 用例见 inventory.test.ts

import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY } from '../blocks';
import { clearBrews } from '../brewing';
import { clearFurnaces } from '../furnace';
import { playerPosition } from '../game';
import { clearDrops, itemDrops } from '../items';
import { emptyBackpack, emptySlots, type Slot } from '../slots';
import { clearStorages, getStorage } from '../storage';
import { useGameStore } from '../store';

const STONE = BLOCK_BY_KEY.stone.id;
const DIRT = BLOCK_BY_KEY.dirt.id;

const stone = (count: number): Slot => ({ kind: 'block', id: STONE, count });
const dirt = (count: number): Slot => ({ kind: 'block', id: DIRT, count });
const coal = (count: number): Slot => ({ kind: 'material', material: 'coal', count });
const pick = (): Slot => ({ kind: 'tool', tool: 'iron_pickaxe', durability: 200 });

function slotsWith(...entries: [number, Slot][]): Slot[] {
  const slots = emptySlots();
  for (const [i, s] of entries) slots[i] = s;
  return slots;
}

function resetStore(): void {
  clearStorages();
  clearFurnaces();
  clearBrews();
  clearDrops();
  useGameStore.getState().loadSurvival({ health: 20, hunger: 20, slots: emptySlots(), backpack: emptyBackpack() });
  useGameStore.setState({
    worldMode: 'survival',
    selectedSlot: 0,
    craftingOpen: false,
    pickerOpen: false,
    furnaceOpen: null,
    brewingOpen: null,
    enchantOpen: null,
    grindstoneOpen: null,
    tradeMob: null,
    storageOpen: null,
    cursorSlot: null,
    hudHidden: false,
  });
}

describe('dropSelected（世界内 Q 丢弃）', () => {
  beforeEach(resetStore);

  it('Q 丢 1 个：手持槽减 1，生成 1 个对应掉落物', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, stone(10)]) });
    useGameStore.getState().dropSelected(false);
    const s = useGameStore.getState();
    expect(s.hotbarSlots[0]).toEqual(stone(9));
    expect(itemDrops).toHaveLength(1);
    expect(itemDrops[0].drop).toEqual({ kind: 'block', blockId: STONE });
    expect(itemDrops[0].count).toBe(1);
  });

  it('Ctrl+Q 丢整组：手持槽清空，掉落物数量为整组', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([2, stone(10)]), selectedSlot: 2 });
    useGameStore.getState().dropSelected(true);
    expect(useGameStore.getState().hotbarSlots[2]).toBeNull();
    expect(itemDrops).toHaveLength(1);
    expect(itemDrops[0].count).toBe(10);
  });

  it('空手持不丢：无掉落物，状态不变', () => {
    const before = useGameStore.getState().hotbarSlots;
    useGameStore.getState().dropSelected(false);
    useGameStore.getState().dropSelected(true);
    expect(itemDrops).toHaveLength(0);
    expect(useGameStore.getState().hotbarSlots).toBe(before);
  });

  it('工具/装备整件丢出（Q 与 Ctrl+Q 相同），耐久/附魔保留', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, pick()]) });
    useGameStore.getState().dropSelected(false);
    expect(useGameStore.getState().hotbarSlots[0]).toBeNull();
    expect(itemDrops).toHaveLength(1);
    expect(itemDrops[0].drop).toEqual({ kind: 'tool', tool: 'iron_pickaxe' });
    expect(itemDrops[0].durability).toBe(200);
  });

  it('只剩 1 个时 Q 丢完槽位清空', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, coal(1)]) });
    useGameStore.getState().dropSelected(false);
    expect(useGameStore.getState().hotbarSlots[0]).toBeNull();
    expect(itemDrops[0].drop).toEqual({ kind: 'material', material: 'coal' });
  });

  it('掉落物生成在玩家面前（眼部高度）；手动丢弃 2s 拾取延迟（age 负偏移）', () => {
    const saved = { ...playerPosition };
    playerPosition.x = 100.5;
    playerPosition.y = 64;
    playerPosition.z = -20.5;
    try {
      useGameStore.setState({ hotbarSlots: slotsWith([0, stone(5)]) });
      useGameStore.getState().dropSelected(false);
      expect(itemDrops).toHaveLength(1);
      const d = itemDrops[0];
      // 测试环境无相机（cameraRef.current === null）：无水平偏移，落在玩家位置、眼部高度
      expect(d.x).toBe(100.5);
      expect(d.z).toBe(-20.5);
      expect(d.y).toBeCloseTo(64 + 1.2);
      // items.ts 拾取条件 age >= 0.5：记 0.5-2=-1.5 → 2 秒后才可拾（Java 手动丢弃，破坏/死亡为 0.5s）
      expect(d.age).toBeCloseTo(-1.5);
    } finally {
      playerPosition.x = saved.x;
      playerPosition.y = saved.y;
      playerPosition.z = saved.z;
    }
  });
});

describe('dropSlot（GUI 悬停 Q）', () => {
  beforeEach(resetStore);

  it('背包槽 Q 丢 1 个、Ctrl+Q 丢整组；面板不受影响', () => {
    useGameStore.setState({ mainSlots: slotsWith([3, stone(10)]), craftingOpen: true });
    const st = useGameStore.getState();
    st.dropSlot('main', 3, false);
    expect(useGameStore.getState().mainSlots[3]).toEqual(stone(9));
    expect(itemDrops.map((d) => d.count)).toEqual([1]);
    st.dropSlot('main', 3, true);
    expect(useGameStore.getState().mainSlots[3]).toBeNull();
    // 同位置同种掉落并入现存堆（items.ts 合并语义）：1 + 9 = 10
    expect(itemDrops.reduce((n, d) => n + d.count, 0)).toBe(10);
    expect(useGameStore.getState().craftingOpen).toBe(true); // 面板保持打开
  });

  it('容器槽可丢（写回容器 map），空格/越界不动', () => {
    useGameStore.setState({ storageOpen: '1,2,3' });
    getStorage('1,2,3')[0] = coal(8);
    const st = useGameStore.getState();
    st.dropSlot('storage', 0, false);
    expect(getStorage('1,2,3')[0]).toEqual(coal(7));
    expect(itemDrops[0].drop).toEqual({ kind: 'material', material: 'coal' });
    st.dropSlot('storage', 5, false); // 空格
    st.dropSlot('storage', 99, true); // 越界
    expect(itemDrops).toHaveLength(1);
    expect(useGameStore.getState().storageOpen).toBe('1,2,3');
  });

  it('GUI 丢弃同为 2s 拾取延迟', () => {
    useGameStore.setState({ mainSlots: slotsWith([0, stone(3)]) });
    useGameStore.getState().dropSlot('main', 0, false);
    expect(itemDrops[0].age).toBeCloseTo(-1.5);
  });
});

describe('swapWithHotbar（GUI 悬停数字键）', () => {
  beforeEach(resetStore);

  it('背包槽 ↔ 热键栏格整组直接交换（异类）', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, dirt(5)]), mainSlots: slotsWith([4, stone(30)]) });
    useGameStore.getState().swapWithHotbar('main', 4, 0);
    const s = useGameStore.getState();
    expect(s.mainSlots[4]).toEqual(dirt(5));
    expect(s.hotbarSlots[0]).toEqual(stone(30));
  });

  it('同类两组也交换位置（不并堆，Java）', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([1, stone(30)]), mainSlots: slotsWith([0, stone(10)]) });
    useGameStore.getState().swapWithHotbar('main', 0, 1);
    const s = useGameStore.getState();
    expect(s.mainSlots[0]).toEqual(stone(30));
    expect(s.hotbarSlots[1]).toEqual(stone(10));
  });

  it('与空热键栏格交换 = 整组移过去', () => {
    useGameStore.setState({ mainSlots: slotsWith([0, pick()]) });
    useGameStore.getState().swapWithHotbar('main', 0, 8);
    const s = useGameStore.getState();
    expect(s.mainSlots[0]).toBeNull();
    expect(s.hotbarSlots[8]).toEqual(pick());
  });

  it('热键栏内互换（悬停热键栏格按别的数字）', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([2, stone(10)], [5, dirt(4)]) });
    useGameStore.getState().swapWithHotbar('hotbar', 2, 5);
    const s = useGameStore.getState();
    expect(s.hotbarSlots[2]).toEqual(dirt(4));
    expect(s.hotbarSlots[5]).toEqual(stone(10));
  });

  it('容器槽 ↔ 热键栏格交换（写回容器 map）', () => {
    useGameStore.setState({ storageOpen: '1,2,3', hotbarSlots: slotsWith([0, coal(3)]) });
    getStorage('1,2,3')[10] = stone(20);
    useGameStore.getState().swapWithHotbar('storage', 10, 0);
    expect(getStorage('1,2,3')[10]).toEqual(coal(3));
    expect(useGameStore.getState().hotbarSlots[0]).toEqual(stone(20));
  });

  it('双空/越界/同格不动（无 set，数组引用不变）', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, stone(10)]) });
    const before = useGameStore.getState();
    const st = useGameStore.getState();
    st.swapWithHotbar('main', 3, 4); // 双空
    st.swapWithHotbar('main', 99, 0); // 越界
    st.swapWithHotbar('main', 0, 9); // 热键栏越界
    st.swapWithHotbar('hotbar', 0, 0); // 同格
    const after = useGameStore.getState();
    expect(after.hotbarSlots).toBe(before.hotbarSlots);
    expect(after.mainSlots).toBe(before.mainSlots);
    expect(after.guiTick).toBe(before.guiTick);
  });
});

describe('closePanels（E 关闭已开面板）', () => {
  beforeEach(resetStore);

  it('关闭当前打开的面板（各面板走自己 setter），未开时为空操作', () => {
    const st = useGameStore.getState();
    st.closePanels(); // 未开：空操作
    expect(useGameStore.getState().furnaceOpen).toBeNull();
    useGameStore.setState({ furnaceOpen: '5,6,7' });
    st.closePanels();
    expect(useGameStore.getState().furnaceOpen).toBeNull();
    useGameStore.setState({ craftingOpen: true });
    st.closePanels();
    expect(useGameStore.getState().craftingOpen).toBe(false);
    useGameStore.setState({ storageOpen: '1,2,3' });
    st.closePanels();
    expect(useGameStore.getState().storageOpen).toBeNull();
  });
});

describe('hudHidden（F1 隐藏 HUD）', () => {
  beforeEach(resetStore);

  it('F1 开关切换，会话内状态（默认显示）', () => {
    expect(useGameStore.getState().hudHidden).toBe(false);
    useGameStore.getState().toggleHudHidden();
    expect(useGameStore.getState().hudHidden).toBe(true);
    useGameStore.getState().toggleHudHidden();
    expect(useGameStore.getState().hudHidden).toBe(false);
  });
});
