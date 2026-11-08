// 오프라인용 캐시. 앱을 고쳐서 다시 올릴 때는 아래 버전 숫자를 올리세요 (v1 -> v2 ...)
const V = 'drumscore-v1';
const CORE = ['./', 'index.html', 'cropmerge.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isCdn = url.hostname === 'cdnjs.cloudflare.com';        // PDF 라이브러리는 한 번 받으면 저장해 두고 계속 사용
  if (!isCdn && url.origin !== location.origin) return;
  e.respondWith(isCdn ? cacheFirst(req) : networkFirst(req));
});
async function cacheFirst(req) {
  const c = await caches.open(V);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  c.put(req, res.clone());
  return res;
}
async function networkFirst(req) {               // 인터넷이 되면 최신 파일, 안 되면 저장해 둔 파일
  const c = await caches.open(V);
  try {
    const res = await fetch(req);
    c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await c.match(req)) || (await c.match('index.html'));
    if (hit) return hit;
    throw err;
  }
}
