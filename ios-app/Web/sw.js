// Offline-first: the app must open in airplane mode, including from an AirDrop link.
const CACHE = 'arcdrop-v5'
const ASSETS = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match('index.html'))),
  )
})
