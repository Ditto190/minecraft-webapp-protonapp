'use client';

// 光标堆叠跟随件（MC Java）：拿起的物品跟随鼠标渲染在 GUI 层最上方（pointer-events-none），
// 全局 pointerup 统一结束拖动分发（store.dragEnd：未形成拖动则对起始格按普通点击处理）。

import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/lib/store';
import { slotEnchanted, slotTile } from './slotDisplay';
import { TileIcon } from './TileIcon';

export function CursorItem() {
  const cursor = useGameStore((s) => s.cursorSlot);
  const dragEnd = useGameStore((s) => s.dragEnd);
  const ref = useRef<HTMLDivElement>(null);
  /** 最近一次指针位置（每次 pointermove 更新；渲染与直写 DOM 共用） */
  const posRef = useRef<{ x: number; y: number } | null>(null);
  /** 是否已拿到首个指针位置（未拿到前不渲染，与原 pos===null 行为一致） */
  const [hasPos, setHasPos] = useState(false);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      // 仅光标有物时跟踪（避免每次鼠标移动都重渲染）
      if (!useGameStore.getState().cursorSlot) return;
      posRef.current = { x: e.clientX, y: e.clientY };
      const el = ref.current;
      if (el) {
        // 已挂载：直写 DOM transform，高频 pointermove 不走 React 渲染
        el.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%,-50%)`;
      } else {
        setHasPos(true); // 首次定位：触发一次渲染建节点（之后不再 setState）
      }
    };
    const up = () => dragEnd();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragEnd]);

  // 首帧定位：节点挂载后按最近指针位置补一次 transform（render 内不读 ref，eslint react-hooks/refs）
  useEffect(() => {
    const el = ref.current;
    const p = posRef.current;
    if (el && p) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%)`;
  }, [hasPos]);

  if (!cursor || !hasPos) return null;
  return (
    <div ref={ref} className="pointer-events-none fixed z-[100]" style={{ left: 0, top: 0 }}>
      <TileIcon tile={slotTile(cursor)} size={32} blockId={cursor.kind === 'block' ? cursor.id : undefined} enchanted={slotEnchanted(cursor)} />
      {cursor.kind !== 'tool' && cursor.kind !== 'armor' && cursor.count > 1 && (
        <span className="absolute bottom-0 right-0 text-[10px] font-bold text-white drop-shadow">{cursor.count}</span>
      )}
    </div>
  );
}
