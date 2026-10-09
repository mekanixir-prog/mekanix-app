// MEKANIX — Service Worker (self-destruct by default)
//
// Why: This app is under active development. The dev server (Next.js 16
// Turbopack) regenerates JS chunks on every code change, but a cache-first
// SW would serve stale chunks from cache and crash the app with
// "module factory is not available" errors.
//
// Until we ship a production build, this SW unconditionally unregisters
// itself and clears all caches on install + activate. Once we ship prod,
// we'll gate this on a `IS_PROD` flag and add proper cache strategies.

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {}
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        // Unregister ourselves.
        await self.registration.unregister();
        // Nuke every cache we can find.
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
        // Force every controlled client to navigate (reload) so they pick up
        // the new SW-less state.
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        clients.forEach((c) => {
          try {
            c.navigate(c.url);
          } catch {}
        });
      } catch {}
      return self.clients.claim();
    })()
  );
});

// Never intercept fetches — pass everything straight through to the network.
self.addEventListener("fetch", () => {});
