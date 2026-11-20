/* يحفظ ملفات التطبيق ليعمل بدون إنترنت. غيّر الرقم عند كل تحديث. */
const CACHE = 'mewshift-v5';
const FILES = ['./', 'index.html', 'css/app.css?v=5', 'js/i18n.js?v=5', 'js/rules.js?v=5', 'js/app.js?v=5', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

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
