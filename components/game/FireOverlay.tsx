// 着火屏幕火焰覆盖层（MC：玩家燃烧时屏幕下半火焰动画）——轮询 lib/game.ts 的
// burningState.burningLeft（Player 着火逻辑每帧写入），燃烧中显示 CSS 火焰层。

import { useEffect, useState } from 'react';
import { burningState } from '../../lib/game';

const FIRE_STYLE = `
@keyframes fire-flicker {
  0% { transform: scaleY(1) translateY(0); opacity: 0.85; }
  25% { transform: scaleY(1.06) translateY(-6px); opacity: 1; }
  50% { transform: scaleY(0.96) translateY(2px); opacity: 0.75; }
  75% { transform: scaleY(1.04) translateY(-4px); opacity: 0.95; }
  100% { transform: scaleY(1) translateY(0); opacity: 0.85; }
}
.fire-overlay {
  position: fixed; inset: 0; z-index: 15; pointer-events: none;
  background:
    radial-gradient(ellipse 34% 60% at 12% 108%, rgba(255, 120, 0, 0.85) 0%, rgba(255, 60, 0, 0.5) 45%, transparent 75%),
    radial-gradient(ellipse 40% 68% at 50% 112%, rgba(255, 160, 20, 0.9) 0%, rgba(255, 80, 0, 0.55) 45%, transparent 78%),
    radial-gradient(ellipse 34% 60% at 88% 108%, rgba(255, 120, 0, 0.85) 0%, rgba(255, 60, 0, 0.5) 45%, transparent 75%),
    linear-gradient(to top, rgba(255, 100, 0, 0.45) 0%, rgba(255, 60, 0, 0.15) 22%, transparent 45%);
  transform-origin: bottom center;
  animation: fire-flicker 0.5s ease-in-out infinite;
}
`;

/** 燃烧中屏幕下半火焰层（z-15：Hud 红屏 z-20 之下，不挡准星与血条） */
export function FireOverlay() {
  const [burning, setBurning] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setBurning(burningState.burningLeft > 0), 150);
    return () => clearInterval(t);
  }, []);
  if (!burning) return null;
  return (
    <>
      <style>{FIRE_STYLE}</style>
      <div className="fire-overlay" />
    </>
  );
}
