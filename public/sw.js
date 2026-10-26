// MEKANIX — Service Worker (DISABLED in dev)
//
// This SW is intentionally a NO-OP in development. It does NOT register
// any fetch handler, does NOT cache anything, and does NOT call
// c.navigate() (which caused an infinite reload loop with stale cached
// pages — the user kept seeing the old version even after server-side
// updates).
//
// On install + activate, it just clears all caches and unregisters itself.
// No fetch interception, no navigation forcing.

// Clear caches on install.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {}
      // skipWaiting so the new SW takes over immediately.
      await self.skipWaiting();
    })()
  );
});

// On activate: unregister self + clear caches. Do NOT navigate clients —
// let the user's browser handle the refresh naturally.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await self.registration.unregister();
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {}
      return self.clients.claim();
    })()
  );
});

// No fetch handler at all — the browser goes straight to the network for
// every request. This guarantees the user always gets the latest version.
