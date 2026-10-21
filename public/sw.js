/* Klipo service worker: kabuğu (HTML/CSS/JS) çevrimdışı açar. API ve medya asla önbelleğe alınmaz. */
const CACHE = 'klipo-shell-v1';
const SHELL = ['/', '/css/app.css', '/js/theme.js', '/js/core.js', '/js/components.js', '/js/view-feed.js',
  '/js/view-explore.js', '/js/view-upload.js', '/js/view-inbox.js', '/js/view-profile.js', '/js/view-settings.js',
  '/js/view-admin.js', '/js/app.js', '/icons/icon-192.png', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/') || url.pathname === '/healthz') return;

  // ağ öncelikli: yeni sürümler hemen görünür, ağ yoksa önbellekten açılır
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (SHELL.includes(url.pathname) || req.mode === 'navigate')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req.mode === 'navigate' ? '/' : req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error()))
      )
  );
});
