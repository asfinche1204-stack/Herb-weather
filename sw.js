// Skywatch service worker: receives push notifications
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(x) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Skywatch', {
    body: d.body || '', icon: 'brand/icon-192.png', badge: 'brand/icon-192.png', tag: d.tag || 'skywatch', renotify: !!d.renotify, data: {url: d.url || './'}
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    const url = new URL(e.notification.data && e.notification.data.url || './', self.location.href).href;
    for (const c of list) { if ('focus' in c) { c.navigate ? c.navigate(url) : null; return c.focus(); } }
    return clients.openWindow(url);
  }));
});
