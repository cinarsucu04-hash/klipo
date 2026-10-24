/* Klipo service worker: kabuğu (HTML/CSS/JS) çevrimdışı açar. API ve medya asla önbelleğe alınmaz. */
const CACHE = 'klipo-shell-v2';
const SHELL = ['/', '/css/app.css', '/js/theme.js', '/js/core.js', '/js/components.js', '/js/fx.js', '/js/push.js', '/js/view-feed.js',
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
  // Uygulama dışındaki sayfalar ve dosyalar (indir.html, Klipo.apk...) doğrudan ağdan gelir; '/' önbelleğini bozmasın
  if (req.mode === 'navigate' && url.pathname !== '/') return;

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

// ---- anlık bildirimler (Web Push) ----
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (err) {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // uygulama ekrandayken ayrıca bildirim göstermeye gerek yok (rozetler zaten yenileniyor)
      if (wins.some((w) => w.visibilityState === 'visible')) return;
      return self.registration.showNotification(d.title || 'Klipo', {
        body: d.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: d.tag || undefined,
        renotify: !!d.tag,
        data: { url: d.url || '/' },
      });
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          try {
            await w.focus();
            if ('navigate' in w) await w.navigate(target);
          } catch (err) { /* sekme kapanmış olabilir */ }
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
