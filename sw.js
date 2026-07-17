// NMD CRM Service Worker — network-first
// האפליקציה תמיד מנסה להביא את הגרסה העדכנית מהרשת;
// המטמון משמש רק כגיבוי כשאין אינטרנט.
const CACHE = 'nmd-crm-v1';
const OFFLINE_ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // רק GET; קריאות API (Supabase וכו') עוברות ישירות לרשת בלי מטמון
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isAppShell = url.origin === self.location.origin;

  if (!isAppShell) return; // CDN/API — לא נוגעים

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});
