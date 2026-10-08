// MEKANIX — Prisma Client with D1 support
//
// On Cloudflare Workers/Pages: uses D1 adapter from the Cloudflare context.
// In local development: uses standard SQLite Prisma Client.
//
// The Cloudflare context is set by OpenNext's init.js via AsyncLocalStorage.
// Access it via: globalThis[Symbol.for("__cloudflare-context__")]

import { PrismaClient } from "@prisma/client";

// Dev-mode singleton (standard SQLite Prisma Client)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const devClient = globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = devClient;

// Check if we're on Cloudflare Workers with D1 binding
function getCloudflareContext(): any | null {
  try {
    const ctx = (globalThis as any)[Symbol.for("__cloudflare-context__")];
    if (ctx?.env?.DB) return ctx;
  } catch {}
  return null;
}

// D1-backed Prisma client cache (per-request)
let d1Client: PrismaClient | null = null;

// Export the db object — this is what all routes import
// On Cloudflare: creates D1-backed client if available
// On Node: uses the dev client
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // Check if Cloudflare context with D1 is available
    const ctx = getCloudflareContext();
    if (ctx?.env?.DB) {
      // Use D1 adapter
      if (!d1Client) {
        // Dynamic import to avoid loading D1 adapter in dev
        const { PrismaD1 } = require("@prisma/adapter-d1");
        const adapter = new PrismaD1(ctx.env.DB);
        d1Client = new PrismaClient({ adapter });
      }
      return (d1Client as any)[prop];
    }
    // Fall back to dev client
    return (devClient as any)[prop];
  },
});
