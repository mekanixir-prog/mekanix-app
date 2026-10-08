// MEKANIX — Prisma Client (Cloudflare-safe)
// On Workers: uses D1 adapter via dynamic import
// On Node: standard PrismaClient

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const isWorker = typeof (globalThis as any).caches !== "undefined" && typeof (process as any).versions?.node === "undefined";

let devClient: PrismaClient | undefined;
if (!isWorker) {
  devClient = globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = devClient;
}

let d1Client: PrismaClient | undefined;
let d1Promise: Promise<PrismaClient> | undefined;

async function getD1Client(): Promise<PrismaClient> {
  if (d1Client) return d1Client;
  if (d1Promise) return d1Promise;
  
  d1Promise = (async () => {
    const { PrismaD1 } = await import("@prisma/adapter-d1");
    const ctx = (globalThis as any)[Symbol.for("__cloudflare-context__")];
    const adapter = new PrismaD1(ctx.env.DB);
    d1Client = new PrismaClient({ adapter });
    return d1Client;
  })();
  
  return d1Promise;
}

// Synchronous client (Node only)
function getSyncClient(): PrismaClient {
  if (devClient) return devClient;
  throw new Error("Database not available");
}

// For Node: synchronous access via Proxy
// For Workers: async D1 via dynamic import
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // On Node, use sync client
    if (!isWorker && devClient) {
      const value = (devClient as any)[prop];
      return typeof value === "function" ? value.bind(devClient) : value;
    }
    
    // On Workers, return async wrapper
    // This is a simplification — D1 calls need to be async
    // For now, throw so we can see if the app loads at all
    throw new Error("D1 async access not supported via sync Proxy");
  },
}) as PrismaClient;
