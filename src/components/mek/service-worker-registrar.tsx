"use client";

import { useEffect } from "react";

/**
 * ServiceWorkerRegistrar — DISABLED in development.
 *
 * Why disabled: the previous SW used c.navigate() to force-reload clients,
 * which created an infinite loop — the old cached page kept reloading
 * itself, never picking up the new server-side code. Users saw stale
 * content even after we pushed fixes.
 *
 * In dev, we DON'T register any SW at all. The browser always fetches
 * fresh resources from the dev server. In production, we can re-enable
 * registration with a proper cache-first strategy.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // DEV: aggressively unregister any existing SW + clear caches so
    // stale content from a previous session is evicted.
    const cleanup = async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
        console.log("[SW] Cleared all service workers + caches (dev mode).");
      } catch {
        // Silent — SW is a progressive enhancement.
      }
    };
    cleanup();
  }, []);

  return null;
}
