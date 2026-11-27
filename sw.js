// 오프라인 지원: 네트워크 우선, 실패하면 캐시.
// 앱 파일은 매번 서버에 "바뀌었나요?"를 물어봄(cache: 'no-cache'). GitHub Pages의 10분 저장 표시 때문에
// 홈 화면 앱이 껐다 켜도 예전 화면을 보여 주는 일을 막음.
// 인터넷이 약해서(헬스장 지하 등) 3초 안에 답이 없으면 저장해 둔 화면을 먼저 보여 줌. 새 파일은 뒤에서 받아 둠.
// 동기화 서버(workers.dev)로 가는 요청은 건드리지 않음.
const CACHE = 'my-health-v30';
const WAIT = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('my-health-v') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const net = fetch(u.href, { cache: 'no-cache' }).then(r => {
    if (r.ok) { const copy = r.clone(); return caches.open(CACHE).then(c => c.put(e.request, copy)).then(() => r); }
    return r;
  });
  e.waitUntil(net.catch(() => {}));
  e.respondWith((async () => {
    const cached = caches.match(e.request, { ignoreSearch: true });
    const slow = new Promise(res => setTimeout(res, WAIT)).then(() => cached);
    // 먼저 오는 쪽: 네트워크 답, 또는 3초 뒤 캐시(있을 때만)
    const first = await Promise.race([net.catch(() => null), slow.then(c => c || net.catch(() => null))]);
    return first || (await cached) || (await net);
  })());
});

// 휴식 끝 알림: 서버(worker)가 내용 없이 보내면 여기서 문구를 정해 보여 줌 (아이폰 알림 소리가 남)
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('휴식 끝! 💪', {
    body: '다음 세트 할 시간이에요', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'rest', renotify: true, data: { url: './' },
  }));
});
// 알림을 누르면 앱을 열거나, 이미 열려 있으면 그 화면으로
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  })());
});
