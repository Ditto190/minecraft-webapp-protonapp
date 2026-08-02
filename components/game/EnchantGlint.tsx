'use client';

// 附魔物品的紫色流动光泽（enchant glint）：absolute 罩层 + 斜向渐变扫动。
// 动画只动 transform（GPU 合成），不碰 background-position 避免大面积重绘；
// mask 由调用方按图标自身形状传入（atlas 定位或 3D 图标 dataURL），光泽只在物品像素上显现。

import type { CSSProperties } from 'react';

const GLINT_CSS = `
.mc-enchant-glint{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.mc-enchant-glint::before{content:"";position:absolute;inset:-60%;will-change:transform;
background:linear-gradient(115deg,transparent 30%,rgba(196,112,255,.26) 43%,rgba(147,80,255,.5) 50%,rgba(196,112,255,.26) 57%,transparent 70%);
animation:mc-enchant-glint-flow 2.6s linear infinite}
@keyframes mc-enchant-glint-flow{from{transform:translate3d(-28%,-28%,0)}to{transform:translate3d(28%,28%,0)}}
@media (prefers-reduced-motion:reduce){.mc-enchant-glint::before{animation:none}}
`;

/** 附魔光泽罩层：铺在图标（relative 容器）正上方；`mask` 与图标的 background 定位一致，把光泽裁成物品形状。
 *  style 标签带 precedence，React 19 提升到 head 并按内容去重（多个附魔图标只有一份 CSS） */
export function EnchantGlint({ mask }: { mask: CSSProperties }) {
  return (
    <>
      <style precedence="mc-enchant-glint">{GLINT_CSS}</style>
      <span className="mc-enchant-glint" aria-hidden style={mask} />
    </>
  );
}
