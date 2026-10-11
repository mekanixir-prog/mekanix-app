// MEKANIX — Prisma Client for Cloudflare Workers (used during build-cloudflare.sh)
//
// This file replaces src/lib/db.ts ONLY during Cloudflare Worker build.
// The build-cloudflare.sh script swaps db.ts → db.worker.ts temporarily.
//
// Why: With engineType="client" (added by build script), ALL PrismaClient
// instances MUST have a driver adapter. The normal db.ts creates PrismaClient
// without adapter, which causes P2038 error during build.
//
// This file provides:
//   - In Workers runtime: lazy Proxy that throws (must use async getDb())
//   - In build time (Node.js): a PrismaClient with a mock adapter that
//     satisfies the "adapter required" check without actually connecting
//
// The 63 consumers of sync `db` continue to import from "@/lib/db" — they
// just get this proxy instead. Only /api/test/d1 uses async getDb().

import { PrismaClient } from "@prisma/client";

// Detect Cloudflare Workers environment
const isCloudflareWorkers =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

let db: PrismaClient;

if (isCloudflareWorkers) {
  // ─── Workers runtime ───
  // sync `db` doesn't work in Workers. Lazy Proxy that throws at runtime.
  // Consumers should use `await getDb()` from db-worker.ts instead.
  db = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `Workers: sync \`db.${String(prop)}\` not supported. Use \`await getDb()\` from @/lib/db-worker.`
        );
      },
    }
  ) as unknown as PrismaClient;
} else {
  // ─── Build time (Node.js) ───
  // With engineType="client", PrismaClient requires an adapter.
  // Create a minimal adapter that satisfies the check without connecting.
  // This is only used during build (page data collection); the actual
  // runtime uses either the Workers proxy (above) or the original db.ts
  // (restored after build).
  const mockAdapter = {
    provider: "sqlite" as const,
    adapterName: "mock-build-adapter",
    connect: async () => ({ execute: async () => ({ rows: [] }) }),
    disconnect: async () => {},
  };
  db = new PrismaClient({ adapter: mockAdapter as any, log: ["error"] });
}

export { db };
export { getDb } from "./db-worker";
