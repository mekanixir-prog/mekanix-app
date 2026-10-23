"use client";

import { useEffect } from "react";

/**
 * ServiceWorkerRegistrar — registers /sw.js on the client.
 *
 * Why a client component instead of next/script or a raw <script> tag:
 * Next.js 16 (Turbopack) forbids <script dangerouslySetInnerHTML> inside
 * React components (it throws "Encountered a script tag while rendering
 * React component"). The idiomatic React/Next.js way to run a side-effect
 * on mount is useEffect inside a "use client" component.
 *
 * In dev (localhost), sw.js self-destructs on install/activate, so any stale
 * SW from a prior session gets evicted. In production, sw.js acts as a
 * normal PWA service worker (cache-first for static assets, network-first
 * for navigation).
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // Register after window load so it doesn't compete with first paint.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Silent — SW is a progressive enhancement, not a hard requirement.
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
