'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { randomSeed, useGameStore, type WorldMode } from '@/lib/store';
import { McButton } from './McButton';

// 设置弹窗懒加载（ssr:false 静态导出必配）：不进首屏 bundle，菜单渲染后并行拉取
const SettingsDialog = dynamic(() => import('./SettingsDialog').then((m) => m.SettingsDialog), { ssr: false });

/** MC 主菜单随机黄色标语 */
const SPLASHES = [
  '网页版！',
  '100% 体素！',
  '无需下载！',
  'Kimi K3 打造！',
  '试试下界！',
  '支持触屏！',
  'Faithful 32x!',
  '开源免费！',
  '也试试末地！',
  '小心苦力怕！',
];

/** 主菜单提示条（存档过旧/损坏等来自 store.notice），2.5s 自动消失，与 Hud 的 Notice 同生命周期 */
function MenuNotice() {
  const notice = useGameStore((s) => s.notice);
  const setNotice = useGameStore((s) => s.setNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);
  if (!notice) return null;
  return (
    <div className="absolute left-1/2 top-6 z-10 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-sm text-yellow-200 shadow [text-shadow:1px_1px_0_#000]">
      {notice}
    </div>
  );
}

/** 主菜单（对齐 MC Java）：全景轮播背景 + 标题/标语 + MC 按钮列 */
export function MainMenu() {
  const [seed, setSeed] = useState(() => randomSeed());
  const [mode, setMode] = useState<WorldMode>('survival');
  const [hasSave, setHasSave] = useState(false);
  const [splash, setSplash] = useState(0);
  const startNew = useGameStore((s) => s.startNew);
  const continueGame = useGameStore((s) => s.continueGame);

  useEffect(() => {
    // 动态 import：persistence（含 idb）不进首屏 bundle；失败静默按无存档处理
    void import('@/lib/persistence')
      .then((m) => m.loadWorldMeta())
      .then((m) => setHasSave(m !== null))
      .catch(() => setHasSave(false));
    // 打开游戏即预载纹理图集（构建 atlas 并缓存；进世界时不再因首次加载图集而卡顿）——
    // 保持 mount 时预热语义，只是静态引用换成动态 import（three/atlas 构建代码不进首屏 bundle）
    void import('@/lib/textures').then((m) => m.getAtlasMaterials());
    // 随机标语（微任务绕过同步 setState 限制，同时避免 SSR 水合不一致）
    queueMicrotask(() => setSplash(Math.floor(Math.random() * SPLASHES.length)));
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden">
      {/* 泥土平铺背景（MC Java 创建世界/选项界面同款） */}
      <div aria-hidden className="mc-dirt pointer-events-none absolute inset-0" />

      {/* 存档提示（过旧/损坏等） */}
      <MenuNotice />

      {/* 标题 + 黄色标语 */}
      <div className="relative mb-8 text-center">
        <h1 className="text-[60px] font-black leading-none tracking-tight text-white [text-shadow:4px_4px_0_#3f3f3f]">
          KIMI<span className="text-emerald-400">·</span>MC
        </h1>
        <div className="mt-2 text-sm font-bold text-white/90 [text-shadow:2px_2px_0_#3f3f3f]">网页版体素沙盒</div>
        <div className="mc-splash absolute -right-20 top-9 whitespace-nowrap text-lg font-bold text-yellow-300 [text-shadow:2px_2px_0_#3f3f3f]">
          {SPLASHES[splash]}
        </div>
      </div>

      {/* 按钮列 */}
      <div className="relative flex w-80 flex-col gap-2">
        <McButton disabled={!hasSave} onClick={continueGame}>
          继续游戏
        </McButton>
        <div className="flex items-center gap-2">
          <input
            aria-label="新世界种子"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="种子（留空随机）"
            className="mc-input min-w-0 flex-1"
          />
          <McButton onClick={() => setSeed(randomSeed())}>随机</McButton>
        </div>
        <McButton onClick={() => startNew(seed.trim() || randomSeed(), mode)}>创建新世界{hasSave ? '（覆盖旧存档）' : ''}</McButton>
        <div className="flex gap-2">
          {(['survival', 'creative'] as const).map((m) => (
            <McButton
              key={m}
              className={`flex-1 ${mode === m ? 'outline outline-2 outline-white' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'survival' ? '生存模式' : '创造模式'}
            </McButton>
          ))}
        </div>
        <SettingsDialog />
      </div>

      {/* 底部信息（对齐 MC：左下角版本、右下角版权） */}
      <div className="absolute bottom-2 left-3 text-xs text-white/80 [text-shadow:1px_1px_0_#000]">
        Kimi K3 开发 · 贴图 Faithful 32x（faithfulpack.net）
      </div>
      <div className="absolute bottom-2 right-3 text-xs text-white/80 [text-shadow:1px_1px_0_#000]">
        音效 Minetest Game（CC BY-SA 3.0）· 详见 public/*/CREDITS.md
      </div>
    </div>
  );
}
