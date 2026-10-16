// MEKANIX — D1 client for Cloudflare Workers
//
// Creates a PrismaClient with PrismaD1 adapter, cached per-request.
//
// Per-request caching strategy:
//   - getCloudflareContext({async:true}) returns the SAME context object
//     within a single HTTP request (it's cached in globalThis by OpenNext).
//   - We store the PrismaClient on ctx.__prismaClient so subsequent calls
//     within the same request reuse the same client.
//   - Across different requests, a new PrismaClient is created (per-request
//     lifecycle, as recommended by OpenNext docs).
//
// In dev: throws (use db.ts instead — PrismaClient with rust engine).

import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import type { D1Database } from "@cloudflare/workers-types";

// Type augmentation: declare DB binding in CloudflareEnv
declare global {
  interface CloudflareEnv {
    DB: D1Database;
  }
}

// Symbol key for storing PrismaClient on the context object.
// Using a Symbol ensures no collision with other properties.
const PRISMA_CLIENT_KEY = Symbol.for("mekanix.prismaClient");

/**
 * Get a PrismaClient connected to D1, cached per-request.
 *
 * The first call within an HTTP request creates a new PrismaClient with
 * a PrismaD1 adapter. Subsequent calls within the same request return
 * the cached instance.
 *
 * @returns PrismaClient connected to D1 (per-request, cached)
 */
export async function getDb(): Promise<PrismaClient> {
  // Lazy import — only available in Workers/OpenNext runtime
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext({ async: true });
  const env = ctx.env;

  if (!env.DB) {
    throw new Error(
      "D1 binding 'DB' not found in Cloudflare env. Check wrangler.toml [[d1_databases]]."
    );
  }

  // Check if we already have a PrismaClient for this request context.
  // The context object is the same across all getCloudflareContext() calls
  // within a single HTTP request, so this caches per-request.
  const cachedClient = (ctx as any)[PRISMA_CLIENT_KEY] as PrismaClient | undefined;
  if (cachedClient) {
    return cachedClient;
  }

  // Create new PrismaClient with PrismaD1 adapter
  const adapter = new PrismaD1(env.DB);
  const prisma = new PrismaClient({ adapter });

  // Cache on the context object for subsequent calls in this request
  (ctx as any)[PRISMA_CLIENT_KEY] = prisma;

  return prisma;
}
