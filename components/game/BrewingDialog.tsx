'use client';

import { useEffect, useState } from 'react';
import { BREW_TIME, getBrew } from '@/lib/brewing';
import { useGameStore } from '@/lib/store';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { AbsSlot, GuiHotbarSlots, GuiMainSlots, McGuiFrame } from './McGui';

/** 酿造进度箭头：250ms 轮询仅重渲本子组件，槽位区（45+ GuiSlot）不随进度刷新 */
function BrewProgress({ brewKey }: { brewKey: string }) {
  const [, setTick] = useState(0);
  // 酿造进度连续变化：打开期间 250ms 刷新（组件随面板卸载，interval 自动停）
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const b = getBrew(brewKey);
  if (!b) return null;
  return (
    <div className="absolute overflow-hidden" style={{ left: 205, top: 32, width: 24, height: 58 }}>
      <div
        className="w-full bg-purple-500/70 transition-[height]"
        style={{ height: `${(b.progress / BREW_TIME) * 100}%` }}
      />
    </div>
  );
}

/** 酿造台界面（MC Java 光标拖拽）：brewing_stand.png 纹理背景，燃料/材料/三药水槽/背包/热键栏按 MC 坐标 absolute 对齐。
 *  放置约束在 action 层：燃料槽只收烈焰粉、材料槽只收酿造材料、药水槽只收药水（1 个）；
 *  shift 快移：对应物品入对应槽，酿造台槽内物品 shift 取出到背包。 */
export function BrewingDialog() {
  const brewKey = useGameStore((s) => s.brewingOpen);
  const setOpen = useGameStore((s) => s.setBrewingOpen);
  const hotbarSlots = useGameStore((s) => s.hotbarSlots);
  const mainSlots = useGameStore((s) => s.mainSlots);
  const slotMouseDown = useGameStore((s) => s.slotMouseDown);
  const slotDragEnter = useGameStore((s) => s.slotDragEnter);
  const slotDoubleClick = useGameStore((s) => s.slotDoubleClick);
  const brewingSlotMouseDown = useGameStore((s) => s.brewingSlotMouseDown);

  // 关闭时直接不渲染：hooks 已全部调用，顺序稳定
  if (!brewKey) return null;
  const b = getBrew(brewKey);

  return (
    <Dialog
      open={brewKey !== null}
      onOpenChange={(o) => {
        if (!o) setOpen(null);
      }}
    >
      <DialogContent className="border-0 bg-transparent p-0 shadow-none sm:max-w-none">
        {b && (
          <McGuiFrame texture="/textures/gui/container/brewing_stand.png">
            {/* 燃料（左上） */}
            <AbsSlot pos={[30, 30]} stack={b.fuel} onPress={(info) => brewingSlotMouseDown('fuel', 0, info)} />
            {/* 材料（上中） */}
            <AbsSlot pos={[158, 30]} stack={b.ingredient} onPress={(info) => brewingSlotMouseDown('ingredient', 0, info)} />
            {/* 药水槽（品字形下 3） */}
            {b.potions.map((p, i) => (
              <AbsSlot
                key={i}
                pos={([[106, 106], [158, 106], [210, 106]] as [number, number][])[i]}
                stack={p}
                onPress={(info) => brewingSlotMouseDown('potion', i, info)}
              />
            ))}
            {/* 进度箭头区（右上）：按酿造进度叠加 */}
            <BrewProgress brewKey={brewKey} />
            <GuiMainSlots
              slots={mainSlots}
              onSlotPress={(i, info) => slotMouseDown('main', i, info)}
              onSlotDragEnter={(i) => slotDragEnter('main', i)}
              onSlotDoubleClick={(i) => slotDoubleClick('main', i)}
            />
            <GuiHotbarSlots
              slots={hotbarSlots}
              onSlotPress={(i, info) => slotMouseDown('hotbar', i, info)}
              onSlotDragEnter={(i) => slotDragEnter('hotbar', i)}
              onSlotDoubleClick={(i) => slotDoubleClick('hotbar', i)}
            />
          </McGuiFrame>
        )}
      </DialogContent>
    </Dialog>
  );
}
