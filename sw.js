/* Home Bar service worker: drink-request push notifications ONLY.
   Deliberately has NO fetch handler — it never caches or serves the app,
   so a stale copy of index.html can never haunt an installed phone. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Home Bar', {
    body: d.body || 'A guest sent a drink request.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'drink-request',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow('.');
  }));
});
