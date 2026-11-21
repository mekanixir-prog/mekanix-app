// MEKANIX — Database access helper for lib files
//
// This file provides a single `getDbForLib()` function that works in BOTH
// environments:
//   - In dev (Node.js + SQLite): returns the sync `db` from db.ts
//   - In Cloudflare Workers: returns async `getDb()` from db-worker.ts
//
// Why this exists:
//   - lib files (auth.ts, rate-limit.ts, etc.) are imported by many routes
//   - In dev, `db` works fine (sync PrismaClient with rust engine)
//   - In Workers, `db` is a Proxy that throws (must use async getDb())
//   - This helper bridges the gap without changing lib function signatures
//
// Usage:
//   const db = await getDbForLib();
//   const user = await db.user.findUnique({ where: { id } });

import type { PrismaClient } from "@prisma/client";

// Detect Cloudflare Workers environment
// In Workers with nodejs_compat, navigator.userAgent is "Cloudflare-Workers"
const isCloudflareWorkers =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

// Cache for dev mode (so we don't re-import db on every call)
let devDb: PrismaClient | null = null;

/**
 * Get a PrismaClient instance for the current environment.
 *
 * - In dev (Node.js): returns the cached sync `db` from db.ts
 * - In Workers: returns a per-request PrismaClient with PrismaD1 adapter
 *
 * @returns PrismaClient connected to SQLite (dev) or D1 (Workers)
 */
export async function getDbForLib(): Promise<PrismaClient> {
  if (isCloudflareWorkers) {
    // In Workers: use async getDb() from db-worker.ts
    const { getDb } = await import("./db-worker");
    return getDb();
  }

  // In dev: use sync db (cached on first access)
  if (!devDb) {
    const { db } = await import("./db");
    devDb = db;
  }
  return devDb;
}
