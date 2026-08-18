// Minimal PWA worker: keeps navigations on the network, falls back to the cached
// home shell when offline — the least Chrome accepts before offering "install".
// ponytail: one cache entry, no asset precache. Cloudflare already sets immutable
// headers on /_astro/; add real offline caching only if pages must work offline.
const CACHE = 'shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Refresh the shell whenever the real home page loads, so it can't rot.
        if (new URL(e.request.url).pathname === '/') {
          const copy = res.clone()
          e.waitUntil(caches.open(CACHE).then((c) => c.put('/', copy)))
        }
        return res
      })
      .catch(() => caches.match('/').then((r) => r || Response.error())),
  )
})
