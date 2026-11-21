/* يحفظ ملفات التطبيق ليعمل بدون إنترنت. غيّر الرقم عند كل تحديث. */
const CACHE = 'mewshift-v28';
const FILES = ['./', 'index.html', 'css/fonts.css?v=28', 'fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2', 'fonts/ibm-plex-sans-arabic-latin-400-normal.woff2', 'fonts/ibm-plex-sans-arabic-arabic-500-normal.woff2', 'fonts/ibm-plex-sans-arabic-latin-500-normal.woff2', 'fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2', 'fonts/ibm-plex-sans-arabic-latin-600-normal.woff2', 'fonts/ibm-plex-sans-arabic-arabic-700-normal.woff2', 'fonts/ibm-plex-sans-arabic-latin-700-normal.woff2', 'fonts/reem-kufi-arabic-500-normal.woff2', 'fonts/reem-kufi-latin-500-normal.woff2', 'fonts/reem-kufi-arabic-700-normal.woff2', 'fonts/reem-kufi-latin-700-normal.woff2', 'css/app.css?v=28', 'js/i18n.js?v=28', 'js/features.js?v=28', 'js/cloud.js?v=28', 'js/rules.js?v=28', 'js/app.js?v=28', 'manifest.webmanifest?v=3', 'icons/icon-192.png?v=3', 'icons/icon-512.png?v=3', 'icons/apple-touch-icon.png?v=3', 'icons/splash-logo.png?v=1', 'img/ihussain-black.png', 'img/ihussain-white.png'];

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
    body: d.body || '', tag: d.tag || 'mewshift', icon: 'icons/icon-192.png?v=3', badge: 'icons/icon-192.png?v=3', lang: 'ar', dir: 'auto'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
