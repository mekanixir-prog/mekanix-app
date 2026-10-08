// MEKANIX — Prisma Client (Cloudflare-safe)
// On Workers: lazy-init with D1 adapter when binding is available
// On Node: standard PrismaClient

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// Only create standard PrismaClient on Node (not Workers)
const isWorker = typeof (globalThis as any).caches !== "undefined" && typeof process.versions?.node === "undefined";

const devClient = (!isWorker && globalForPrisma.prisma) 
  ? globalForPrisma.prisma 
  : (!isWorker ? new PrismaClient({ log: ["error", "warn"] }) : null);

if (!isWorker && process.env.NODE_ENV !== "production" && !globalForPrisma.prisma) {
  globalForPrisma.prisma = devClient;
}

// Lazy D1 client
let d1Client: any = null;

function getClient(): any {
  // Check for Cloudflare D1 binding
  try {
    const ctx = (globalThis as any)[Symbol.for("__cloudflare-context__")];
    if (ctx?.env?.DB) {
      if (!d1Client) {
        const { PrismaD1 } = require("@prisma/adapter-d1");
        d1Client = new PrismaClient({ adapter: new PrismaD1(ctx.env.DB) });
      }
      return d1Client;
    }
  } catch {}
  
  // Node dev mode
  if (devClient) return devClient;
  
  // Workers without D1 — return a stub that throws on use
  return new Proxy({}, {
    get: () => () => { throw new Error("D1 binding not available"); }
  });
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;
