// 서비스워커: 앱을 휴대폰·PC 에 "설치"할 수 있게 하고, 서버가 새 버전이 되면 다시 설치 없이 갱신한다.
// __APP_VERSION__ 은 서버가 이 파일을 보낼 때 실제 버전으로 바꿔 넣는다. 버전이 바뀌면 브라우저가 새 워커를 내려받는다.
const VERSION = '__APP_VERSION__';
const CACHE = `rrh-shell-${VERSION}`;
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  // 처음 설치할 때는 바로 활성화한다. 업데이트일 때는 사용자가 "지금 적용"을 누를 때까지 기다린다.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('rrh-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // API 는 항상 서버로
  // 네트워크 우선: 온라인이면 항상 최신 파일, 오프라인이면 저장해 둔 화면을 보여 준다.
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && SHELL.includes(url.pathname)) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
        throw new Error('offline');
      }
    })(),
  );
});
