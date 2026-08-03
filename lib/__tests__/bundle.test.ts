// 收纳袋（Java 1.21.2 bundle）：容量点模型（64 点，每件占 64/最大堆叠 点，不可堆叠占满）、
// 装袋（右键拿着物品点袋，尽量装入）、倒袋（拿着袋右键点槽，LIFO 最多一组）、袋中袋禁止、
// 序列化往返与旧档兼容；末尾为 store 光标 action 集成测试

import { beforeEach, describe, expect, it } from 'vitest';
import { BLOCK_BY_KEY } from '../blocks';
import { clearBrews } from '../brewing';
import { clearFurnaces } from '../furnace';
import { clearDrops, itemDrops } from '../items';
import { clickSlot, insertIntoBundle, isStackable, pourBundle, rightClickSlot, sameStack } from '../inventory';
import {
  BUNDLE_CAPACITY,
  bundleContents,
  bundleUnits,
  bundleUsed,
  countsOf,
  emptyBackpack,
  emptyBundle,
  emptySlots,
  isBundleSlot,
  type Slot,
} from '../slots';
import { clearStorages } from '../storage';
import { useGameStore } from '../store';

const STONE = BLOCK_BY_KEY.stone.id;
const DIRT = BLOCK_BY_KEY.dirt.id;

const stone = (count: number): NonNullable<Slot> => ({ kind: 'block', id: STONE, count });
const dirt = (count: number): NonNullable<Slot> => ({ kind: 'block', id: DIRT, count });
const coal = (count: number): NonNullable<Slot> => ({ kind: 'material', material: 'coal', count });
const pearl = (count: number): NonNullable<Slot> => ({ kind: 'material', material: 'ender_pearl', count });
const pick = (): NonNullable<Slot> => ({ kind: 'tool', tool: 'iron_pickaxe', durability: 200 });
/** 带内容物的收纳袋（测试构造；条目顺序 = 放入顺序，末尾为最后放入） */
const bundle = (items: Slot[] = []): NonNullable<Slot> => ({ kind: 'material', material: 'bundle', count: 1, bundleItems: items });

function slotsWith(...entries: [number, Slot][]): Slot[] {
  const slots = emptySlots();
  for (const [i, s] of entries) slots[i] = s;
  return slots;
}

describe('容量模型（64 点，每件占 64/最大堆叠 点）', () => {
  it('64 堆叠物品占 1 点/个，16 堆叠占 4 点/个，不可堆叠占 64 点=满袋', () => {
    expect(bundleUnits(stone(1))).toBe(1);
    expect(bundleUnits(coal(1))).toBe(1);
    expect(bundleUnits(pearl(1))).toBe(4);
    expect(bundleUnits(pick())).toBe(64);
  });

  it('bundleUsed 合计多种物品；空袋为 0', () => {
    expect(bundleUsed(bundle([stone(10), pearl(4)]))).toBe(10 + 16);
    expect(bundleUsed(emptyBundle())).toBe(0);
  });

  it('无 bundleItems 字段的旧档按空袋处理', () => {
    const legacy: Slot = { kind: 'material', material: 'bundle', count: 1 };
    expect(isBundleSlot(legacy)).toBe(true);
    expect(bundleContents(legacy)).toEqual([]);
    expect(bundleUsed(legacy)).toBe(0);
  });

  it('收纳袋不可堆叠：不参与合并/聚合计数', () => {
    expect(isStackable(emptyBundle())).toBe(false);
    expect(sameStack(emptyBundle(), emptyBundle())).toBe(false);
    expect(countsOf([bundle([coal(5)]), coal(3)])).toEqual({ 'material:coal': 3 });
  });
});

describe('insertIntoBundle（装袋）', () => {
  it('整叠装入空袋，光标清空', () => {
    const r = insertIntoBundle(emptyBundle(), stone(10));
    expect(bundleContents(r.bundle)).toEqual([stone(10)]);
    expect(r.cursor).toBeNull();
  });

  it('容量不足时尽量装入，余数留光标', () => {
    const r = insertIntoBundle(bundle([stone(60)]), stone(10));
    expect(bundleContents(r.bundle)).toEqual([stone(64)]);
    expect(r.cursor).toEqual(stone(6));
  });

  it('16 堆叠物品占 4 点：20 颗末影珍珠只装得进 16 颗', () => {
    const r = insertIntoBundle(emptyBundle(), pearl(20));
    expect(bundleContents(r.bundle)).toEqual([pearl(16)]);
    expect(bundleUsed(r.bundle)).toBe(BUNDLE_CAPACITY);
    expect(r.cursor).toEqual(pearl(4));
  });

  it('不可堆叠工具占满整袋：空袋可装，有一件物品即装不进', () => {
    const r = insertIntoBundle(emptyBundle(), pick());
    expect(bundleContents(r.bundle)).toEqual([pick()]);
    expect(bundleUsed(r.bundle)).toBe(BUNDLE_CAPACITY);
    expect(r.cursor).toBeNull();
    const b = bundle([stone(1)]);
    const denied = insertIntoBundle(b, pick());
    expect(denied.bundle).toBe(b);
    expect(denied.cursor).toEqual(pick());
  });

  it('满袋装入：引用不变（store 据此判断无操作）', () => {
    const b = bundle([stone(64)]);
    const r = insertIntoBundle(b, dirt(1));
    expect(r.bundle).toBe(b);
    expect(r.cursor).toEqual(dirt(1));
  });

  it('袋中袋禁止', () => {
    const b = emptyBundle();
    const r = insertIntoBundle(b, bundle([stone(5)]));
    expect(r.bundle).toBe(b);
    expect(isBundleSlot(r.cursor)).toBe(true);
  });

  it('混装多种物品各占条目；同类再装入并入并移到末尾（LIFO 基准）', () => {
    let b = insertIntoBundle(emptyBundle(), stone(5)).bundle;
    b = insertIntoBundle(b, coal(5)).bundle;
    b = insertIntoBundle(b, stone(5)).bundle;
    expect(bundleContents(b)).toEqual([coal(5), stone(10)]);
    expect(bundleUsed(b)).toBe(15);
  });

  it('旧档空袋（无 bundleItems 字段）可直接装入', () => {
    const legacy: Slot = { kind: 'material', material: 'bundle', count: 1 };
    const r = insertIntoBundle(legacy, stone(3));
    expect(bundleContents(r.bundle)).toEqual([stone(3)]);
  });
});

describe('pourBundle（倒袋，LIFO 最多一组）', () => {
  it('倒出最后放入的那种物品到空槽', () => {
    const r = pourBundle(bundle([stone(10), coal(5)]), null);
    expect(r.target).toEqual(coal(5));
    expect(bundleContents(r.bundle)).toEqual([stone(10)]);
  });

  it('同类再装入后条目移到末尾：后装的石头先倒出来', () => {
    const r = pourBundle(bundle([coal(5), stone(10)]), null);
    expect(r.target).toEqual(stone(10));
    expect(bundleContents(r.bundle)).toEqual([coal(5)]);
  });

  it('最多一组：条目超 64 只倒 64，余数留袋', () => {
    const r = pourBundle(bundle([stone(80)]), null);
    expect(r.target).toEqual(stone(64));
    expect(bundleContents(r.bundle)).toEqual([stone(16)]);
  });

  it('倒到同类未满槽：并到 64，余数留袋', () => {
    const r = pourBundle(bundle([stone(10)]), stone(60));
    expect(r.target).toEqual(stone(64));
    expect(bundleContents(r.bundle)).toEqual([stone(6)]);
  });

  it('目标为异类 / 已满 / 不可堆叠：引用不变', () => {
    const b = bundle([stone(10)]);
    expect(pourBundle(b, dirt(5)).bundle).toBe(b);
    expect(pourBundle(b, stone(64)).bundle).toBe(b);
    expect(pourBundle(b, pick()).bundle).toBe(b);
  });

  it('不可堆叠条目整件倒出', () => {
    const r = pourBundle(bundle([pick()]), null);
    expect(r.target).toEqual(pick());
    expect(bundleContents(r.bundle)).toEqual([]);
  });

  it('空袋倒不出东西：引用不变', () => {
    const b = emptyBundle();
    const r = pourBundle(b, null);
    expect(r.bundle).toBe(b);
    expect(r.target).toBeNull();
  });
});

describe('rightClickSlot 收纳袋接线', () => {
  it('拿着物品右键点袋 = 尽量装入', () => {
    const r = rightClickSlot(slotsWith([0, bundle([stone(60)])]), 0, stone(10));
    expect(bundleContents(r.slots[0])).toEqual([stone(64)]);
    expect(r.cursor).toEqual(stone(6));
  });

  it('拿着袋右键点空槽 = 倒出最后放入的一种；袋留在光标上（空倒出空袋）', () => {
    const r = rightClickSlot(slotsWith(), 2, bundle([stone(10), coal(5)]));
    expect(r.slots[2]).toEqual(coal(5));
    expect(bundleContents(r.cursor)).toEqual([stone(10)]);
  });

  it('拿着袋右键点异类槽 / 袋点袋：不动', () => {
    const slots = slotsWith([0, dirt(5)], [1, emptyBundle()]);
    expect(rightClickSlot(slots, 0, bundle([stone(10)])).slots).toBe(slots);
    expect(rightClickSlot(slots, 1, bundle([stone(10)])).slots).toBe(slots);
  });

  it('空光标右键点袋 = 拿起整个袋（含内容物）', () => {
    const r = rightClickSlot(slotsWith([0, bundle([stone(10)])]), 0, null);
    expect(bundleContents(r.cursor)).toEqual([stone(10)]);
    expect(r.slots[0]).toBeNull();
  });

  it('左键点袋不触发装袋：按不可堆叠交换', () => {
    const r = clickSlot(slotsWith([0, bundle([coal(5)])]), 0, stone(10));
    expect(r.slots[0]).toEqual(stone(10));
    expect(bundleContents(r.cursor)).toEqual([coal(5)]);
  });
});

// ——— store 光标 action 集成（slotMouseDown/dragEnd/stowCursor/creativeGive） ———

const RIGHT = { button: 2, shift: false };

function resetStore(): void {
  clearStorages();
  clearFurnaces();
  clearBrews();
  clearDrops();
  useGameStore.getState().loadSurvival({ health: 20, hunger: 20, slots: emptySlots(), backpack: emptyBackpack() });
  useGameStore.setState({ worldMode: 'survival', craftingOpen: false, storageOpen: null, cursorSlot: null });
  useGameStore.getState().dragEnd(); // 清掉上个用例可能残留的拖动 pending
}

describe('store 收纳袋交互', () => {
  beforeEach(resetStore);

  it('拿着物品右键点袋（按下+松开）= 装入袋中', () => {
    useGameStore.setState({ hotbarSlots: slotsWith([0, emptyBundle()]), cursorSlot: stone(10) });
    const st = useGameStore.getState();
    st.slotMouseDown('hotbar', 0, RIGHT);
    st.dragEnd();
    const cur = useGameStore.getState();
    expect(bundleContents(cur.hotbarSlots[0])).toEqual([stone(10)]);
    expect(cur.cursorSlot).toBeNull();
  });

  it('拿着袋右键点空槽 = 倒出最后放入的一种', () => {
    useGameStore.setState({ cursorSlot: bundle([stone(10), coal(5)]) });
    const st = useGameStore.getState();
    st.slotMouseDown('main', 4, RIGHT);
    st.dragEnd();
    const cur = useGameStore.getState();
    expect(cur.mainSlots[4]).toEqual(coal(5));
    expect(bundleContents(cur.cursorSlot)).toEqual([stone(10)]);
  });

  it('stowCursor：袋退回背包保留内容物；背包满时袋与内容物散出掉落', () => {
    useGameStore.setState({ cursorSlot: bundle([stone(10)]) });
    useGameStore.getState().stowCursor();
    let cur = useGameStore.getState();
    expect(cur.cursorSlot).toBeNull();
    expect(bundleContents(cur.hotbarSlots[0])).toEqual([stone(10)]);
    // 全满 → 袋本身 + 内容物都在脚下掉落（不静默丢内容物）
    useGameStore.setState({
      hotbarSlots: emptySlots().map(() => stone(64)),
      mainSlots: emptyBackpack().map(() => stone(64)),
      cursorSlot: bundle([dirt(7)]),
    });
    useGameStore.getState().stowCursor();
    cur = useGameStore.getState();
    expect(cur.cursorSlot).toBeNull();
    expect(itemDrops.some((d) => d.drop.kind === 'material' && d.drop.material === 'bundle' && d.count === 1)).toBe(true);
    expect(itemDrops.filter((d) => d.drop.kind === 'block' && d.drop.blockId === DIRT).reduce((n, d) => n + d.count, 0)).toBe(7);
  });

  it('creativeGive：袋钳回 1 个（不可堆叠）', () => {
    useGameStore.getState().creativeGive({ kind: 'material', material: 'bundle', count: 64 });
    const slot = useGameStore.getState().hotbarSlots[0];
    expect(isBundleSlot(slot)).toBe(true);
    expect(slot?.kind === 'material' && slot.count).toBe(1);
  });
});

describe('序列化往返', () => {
  it('JSON 往返保留袋内容物（含工具条目的耐久/附魔字段）', () => {
    const b = bundle([stone(10), coal(5), { kind: 'tool', tool: 'iron_pickaxe', durability: 123, ench: { efficiency: 2 } }]);
    const parsed = JSON.parse(JSON.stringify(b)) as Slot;
    expect(bundleContents(parsed)).toEqual(bundleContents(b));
    expect(bundleUsed(parsed)).toBe(10 + 5 + 64); // stone 10 点 + coal 5 点 + 工具 64 点（仅验字段保真，非合法容量）
    expect(bundleContents(parsed)[2]).toEqual({ kind: 'tool', tool: 'iron_pickaxe', durability: 123, ench: { efficiency: 2 } });
  });

  it('旧档槽位（无 bundleItems 字段）JSON 读入后按空袋处理且可继续装入', () => {
    const parsed = JSON.parse(JSON.stringify({ kind: 'material', material: 'bundle', count: 1 })) as Slot;
    expect(bundleUsed(parsed)).toBe(0);
    const r = insertIntoBundle(parsed, stone(3));
    expect(bundleContents(r.bundle)).toEqual([stone(3)]);
  });
});
