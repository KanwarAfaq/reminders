// App-shell cache so the app opens instantly and offline. Websites themselves are never cached here.
const V = 'rem-v1', SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).catch(() => caches.match('/'))); return; }
  e.respondWith(caches.match(r).then(hit => {
    const net = fetch(r).then(res => { if (res.ok) caches.open(V).then(c => c.put(r, res.clone())); return res; }).catch(() => hit);
    return hit || net;
  }));
});

// Web Push: show the reminder with vibration, and open the right page when tapped.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Kanwar Reminders', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kanwar Reminders', {
    body: d.body || '', tag: d.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    vibrate: d.vibrate || [300, 150, 300], requireInteraction: true, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ('focus' in c) { c.navigate?.(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
