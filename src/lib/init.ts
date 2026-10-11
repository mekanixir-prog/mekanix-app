// MEKANIX — Server initialization (Cloudflare-safe)
// Only initializes on Node.js, not on Workers.

const isWorker =
  typeof (globalThis as any).caches !== "undefined" &&
  typeof (process as any).versions?.node === "undefined";

if (!isWorker) {
  // Only init on Node.js (dev mode)
  // Use dynamic import() instead of require() to satisfy ESLint's no-require-imports rule.
  (async () => {
    try {
      const { initEtaProvider } = await import("./eta-provider");
      const { initSmsProvider } = await import("./sms-provider");
      initEtaProvider();
      initSmsProvider();
    } catch {
      // ignore — providers are optional
    }
  })();
}
