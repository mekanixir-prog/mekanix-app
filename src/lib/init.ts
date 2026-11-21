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

    // Auto-seed the database if it's empty (first dev server start).
    // This ensures demo users, technicians, vehicles, and jobs exist so
    // the guest flow works without manual `tsx prisma/seed.ts`.
    try {
      const { ensureSeedData } = await import("./auto-seed");
      await ensureSeedData();
    } catch {
      // ignore — seed is best-effort
    }
  })();
}
