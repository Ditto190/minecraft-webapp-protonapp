// kimi-mc Service Worker：离线可玩
// 策略：install 期 precache 关键静态资产（贴图/音效，清单由 scripts/gen-sw-precache.mjs 生成，限流并发写入）；
// 页面 network-first（保证新版本及时生效）；纹理 stale-while-revalidate（先用缓存渲染，后台回源刷新——atlas 随版本变化，下次访问即新版本）；
// 其余静态资源 cache-first（JS chunk 带内容哈希，安全长缓存）
// 子路径部署（GitHub Pages 项目页）兼容：所有路径相对 SW scope 解析，不写根绝对路径

const CACHE = 'kimi-mc-v6';

// SW scope 基址：根路径部署为 'https://host/'，子路径部署为 'https://host/minecraft-web/'
const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname; // 恒以 '/' 结尾

// precache 清单（构建时由 prebuild 生成；缺失时静默降级为纯懒缓存）
// importScripts 的参数相对 SW 脚本 URL 解析，子路径部署下同样命中同目录清单
try {
  importScripts('sw-precache-manifest.js');
} catch {
  // ignore
}
const PRECACHE = self.__PRECACHE_MANIFEST__ || [];

self.addEventListener('install', (event) => {
  // 限流并发（6 路）逐个 fetch 写入：全并发会瞬时打满连接、低端设备上 install 易超时；
  // 个别资产 404 不阻塞 SW 安装；清单条目为相对路径，相对 scope 解析
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      let i = 0;
      const lane = async () => {
        while (i < PRECACHE.length) {
          const url = PRECACHE[i++];
          await cache.add(new URL(url, SCOPE)).catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: 6 }, lane));
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先，离线回退到缓存的首页（scope 即应用入口，兼容子路径部署）
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SCOPE, copy));
          return res;
        })
        .catch(() => caches.match(SCOPE)),
    );
    return;
  }

  // 纹理（atlas/pack/水面条带）：stale-while-revalidate——命中缓存立即返回渲染，同时后台回源比对，
  // 拿到新版本静默更新缓存（atlas 随版本变化，下次访问即新图，旧缓存不会永久错位）；
  // 比 network-first 省每次首字节等待（atlas 484 KB），比纯 cache-first 及时；未命中则回源
  if (url.pathname.startsWith(`${SCOPE_PATH}textures/`)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const revalidate = fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => null);
        return cached || revalidate.then((res) => res || Response.error());
      }),
    );
    return;
  }

  // 静态资源（JS/CSS/音效/图标）：缓存优先，未命中回源并写入缓存
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
