// MEKANIX — Prisma Client with D1 support
// Uses @prisma/adapter-d1 on Cloudflare, standard SQLite in dev.

import { PrismaClient } from "@prisma/client";
import { PrismaD1 } from "@prisma/adapter-d1";

// Dev-mode singleton
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };
const devClient = globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = devClient;

// Get Cloudflare context (set by OpenNext)
function getD1Binding(): any {
  try {
    const ctx = (globalThis as any)[Symbol.for("__cloudflare-context__")];
    return ctx?.env?.DB ?? null;
  } catch {
    return null;
  }
}

// Cache for D1-backed client (per Worker instance)
let d1Client: PrismaClient | null = null;

function getClient(): PrismaClient {
  const d1 = getD1Binding();
  if (d1) {
    if (!d1Client) {
      const adapter = new PrismaD1(d1);
      d1Client = new PrismaClient({ adapter });
    }
    return d1Client;
  }
  return devClient;
}

// Proxy that routes to the correct client
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = (client as any)[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as PrismaClient;
