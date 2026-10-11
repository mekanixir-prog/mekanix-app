// MEKANIX — Experimental D1 client for Cloudflare Workers
//
// ⚠️ EXPERIMENTAL — only used by /api/test/d1 for D1 validation.
// NOT used by the 63 consumers of sync `db` (they use db.ts which works in dev).
//
// In Workers: getCloudflareContext + PrismaD1 adapter
// In dev: throws (use db.ts instead)

import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";
import type { D1Database } from "@cloudflare/workers-types";

// Type augmentation: declare DB binding in CloudflareEnv
declare global {
  interface CloudflareEnv {
    DB: D1Database;
  }
}

export async function getDb(): Promise<PrismaClient> {
  // Lazy import getCloudflareContext — only available in Workers/OpenNext
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext({ async: true });
  const env = ctx.env;

  if (!env.DB) {
    throw new Error(
      "D1 binding 'DB' not found in Cloudflare env. Check wrangler.toml [[d1_databases]]."
    );
  }

  const adapter = new PrismaD1(env.DB);
  const prisma = new PrismaClient({ adapter });
  return prisma;
}
