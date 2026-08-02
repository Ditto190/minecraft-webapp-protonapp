'use client';

import { useEffect, useRef, useState } from 'react';
import { portalState } from '@/lib/game';
import { useGameStore } from '@/lib/store';

/**
 * 维度切换过渡层：subscribe store 的 dimension，切换时全屏紫色漩涡渐变淡入淡出（MC 传送门紫色观感）。
 * 纯 DOM/CSS，挂在 GameCanvas（Canvas 外、page.tsx 的 fixed 容器内）。
 *
 * 门内渐进眩晕（MC Java：站门内读秒 ~4s 期间屏幕逐渐叠加紫色扭曲）：读秒进度由 Player 每帧写入
 * lib/game.ts 的 portalState.charge（0→1），本组件 100ms 轮询，按 charge 内联设置眩晕层的不透明度与
 * 整层形变（漩涡/波浪纹理各自无限旋转/脉动，整层强度随 charge 上升）；离门 charge 归 0 后经 CSS
 * transition 快速消退（~0.28s 后卸载）。与切换瞬间的一次性强过渡共存：切换那一下 charge 归 0、
 * 眩晕层淡出，过渡层照常播全屏动画。
 */

/** 门内读秒进度 0-1：Player 每帧写入 lib/game.ts 的 portalState.charge（clamp 到 0-1 读） */
function portalCharge(): number {
  const c = portalState.charge;
  return c >= 1 ? 1 : c > 0 ? c : 0;
}

// keyframes 无法内联，项目的 keyframes 集中在 app/globals.css（不在本任务可改范围内），故组件自带 <style>
const CSS = `
.mc-portal-transition {
  position: fixed;
  inset: 0;
  z-index: 30; /* Hud 受击红屏 z-20 之上，整屏遮盖 */
  pointer-events: none;
  overflow: hidden;
  background: radial-gradient(circle at 50% 50%,
    rgba(147, 74, 222, 0.55) 0%,
    rgba(94, 38, 159, 0.72) 52%,
    rgba(35, 12, 64, 0.92) 100%);
  animation: mc-portal-fade 0.95s ease-in-out forwards;
}
.mc-portal-swirl {
  position: absolute;
  inset: -30%; /* 放大出屏，旋转时不露边角 */
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(196, 141, 255, 0.28) 0deg 14deg,
    transparent 14deg 34deg);
  mix-blend-mode: screen;
  animation: mc-portal-spin 0.95s linear forwards;
}
@keyframes mc-portal-fade {
  0% { opacity: 0; transform: scale(1.18); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes mc-portal-spin {
  from { transform: rotate(0deg) scale(1.25); }
  to { transform: rotate(170deg) scale(1); }
}
`;

// 门内眩晕层样式：整层强度（opacity/transform）由轮询内联写入，transition 平滑步进并在 charge 归 0 时快速淡出；
// 漩涡/波浪纹理幅度固定、无限缓动，靠整层 opacity 随 charge 渐显
const NAUSEA_CSS = `
.mc-portal-nausea {
  position: fixed;
  inset: -8%; /* 放大出屏：整层随 charge 轻微缩放/旋转时不露边角 */
  z-index: 25; /* Hud 受击红屏 z-20 之上、切换过渡层 z-30 之下 */
  pointer-events: none;
  overflow: hidden;
  background: radial-gradient(circle at 50% 50%,
    rgba(147, 74, 222, 0.5) 0%,
    rgba(94, 38, 159, 0.62) 52%,
    rgba(35, 12, 64, 0.85) 100%);
  opacity: 0; /* 实际强度 = charge × 0.85，由轮询内联覆盖 */
  transition: opacity 90ms linear, transform 120ms linear;
}
.mc-portal-nausea-swirl {
  position: absolute;
  inset: -30%; /* 放大出屏，旋转时不露边角 */
  background: repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(196, 141, 255, 0.24) 0deg 12deg,
    transparent 12deg 30deg);
  mix-blend-mode: screen;
  animation: mc-portal-nausea-spin 9s linear infinite;
}
.mc-portal-nausea-waves {
  position: absolute;
  inset: -30%;
  background: repeating-radial-gradient(circle at 50% 50%,
    rgba(170, 110, 235, 0.13) 0 26px,
    transparent 26px 64px);
  mix-blend-mode: screen;
  animation: mc-portal-nausea-pulse 3.2s ease-in-out infinite;
}
@keyframes mc-portal-nausea-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes mc-portal-nausea-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.07); }
}
`;

export function PortalTransition() {
  const dimension = useGameStore((s) => s.dimension);
  const [active, setActive] = useState(false);

  // 门内眩晕层：charge > 0 才挂载，强度轮询内联写入 DOM（不 setState 重渲染）；charge 归 0 淡出后延时卸载
  const [nausea, setNausea] = useState(false);
  const nauseaRef = useRef<HTMLDivElement>(null);
  const nauseaFade = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 订阅维度变化（subscribe 回调只在变更时触发，天然跳过初始维度）：
    // 读档按 meta 恢复维度（World.tsx）发生在 worldReady 之前，加载层还盖着，不播过渡避免进档闪紫
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useGameStore.subscribe((s, prev) => {
      if (s.dimension === prev.dimension || !s.worldReady) return;
      setActive(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setActive(false), 950); // 与 CSS 动画时长一致，淡出结束后卸载
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 轮询门内读秒进度：>0 时挂载眩晕层并内联写入强度；归 0 后经 CSS transition 淡出，0.28s 后卸载
  useEffect(() => {
    const poll = setInterval(() => {
      const c = portalCharge();
      const el = nauseaRef.current;
      if (c > 0) {
        if (nauseaFade.current) { // 淡出中又回门：取消卸载
          clearTimeout(nauseaFade.current);
          nauseaFade.current = null;
        }
        setNausea(true);
        if (el) {
          el.style.opacity = String(c * 0.85);
          el.style.transform = `scale(${(1 + c * 0.05).toFixed(3)}) rotate(${(c * 1.6).toFixed(2)}deg)`;
        }
      } else if (el && !nauseaFade.current) {
        el.style.opacity = '0';
        nauseaFade.current = setTimeout(() => {
          nauseaFade.current = null;
          setNausea(false);
        }, 280);
      }
    }, 100);
    return () => {
      clearInterval(poll);
      if (nauseaFade.current) clearTimeout(nauseaFade.current);
    };
  }, []);

  return (
    <>
      {nausea && (
        <div ref={nauseaRef} className="mc-portal-nausea" aria-hidden>
          <style>{NAUSEA_CSS}</style>
          <div className="mc-portal-nausea-swirl" />
          <div className="mc-portal-nausea-waves" />
        </div>
      )}
      {active && (
        // key=dimension：连续切换时强制重建，动画从头播
        <div key={dimension} className="mc-portal-transition" aria-hidden>
          <style>{CSS}</style>
          <div className="mc-portal-swirl" />
        </div>
      )}
    </>
  );
}
