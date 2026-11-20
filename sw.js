/* يحفظ ملفات التطبيق ليعمل بدون إنترنت. غيّر الرقم عند كل تحديث. */
const CACHE = 'mewshift-v7';
const FILES = ['./', 'index.html', 'css/app.css?v=7', 'js/i18n.js?v=7', 'js/rules.js?v=7', 'js/app.js?v=7', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* الشبكة أولاً (مع تجاوز ذاكرة المتصفح المؤقتة)، والنسخة المحفوظة عند انقطاع الإنترنت */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, new URL(e.request.url).origin === location.origin ? { cache: 'no-cache' } : {}).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

/* إشعارات الخادم (تصل حتى والتطبيق مغلق) */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'MEW Shift', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MEW Shift', {
    body: d.body || '', tag: d.tag || 'mewshift', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'ar', dir: 'auto'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
