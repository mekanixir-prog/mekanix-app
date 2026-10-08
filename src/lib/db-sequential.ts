// MEKANIX — Sequential DB Operations (D1-compatible)
//
// D1 does NOT support Prisma $transaction.
// On Cloudflare Workers: sequential writes (no atomic transaction)
// On Node.js dev: use $transaction (works fine with SQLite)

import { db } from "./db";

export async function runSequential(ops: (() => Promise<any>)[], txClient?: any): Promise<any[]> {
  // If a transaction client is passed, use it
  if (txClient) {
    const results: any[] = [];
    for (const op of ops) {
      results.push(await op());
    }
    return results;
  }

  // Check if $transaction is available (Node mode)
  if (typeof (db as any).$transaction === "function") {
    return db.$transaction(async (tx: any) => {
      const results: any[] = [];
      for (const op of ops) {
        results.push(await op());
      }
      return results;
    });
  }

  // D1 mode: sequential writes (no transaction)
  const results: any[] = [];
  for (const op of ops) {
    results.push(await op());
  }
  return results;
}
