// MEKANIX — Server initialization (Cloudflare-safe)
// Only initializes on Node.js, not on Workers.

const isWorker = typeof (globalThis as any).caches !== "undefined" && typeof (process as any).versions?.node === "undefined";

if (!isWorker) {
  // Only init on Node.js (dev mode)
  try {
    const { initEtaProvider } = require("./eta-provider");
    const { initSmsProvider } = require("./sms-provider");
    initEtaProvider();
    initSmsProvider();
  } catch {}
}
