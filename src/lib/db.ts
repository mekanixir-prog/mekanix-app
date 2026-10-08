// MEKANIX — Prisma Client
// Node: standard PrismaClient
// Workers: stub (D1 integration TBD)

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const devClient = globalForPrisma.prisma ?? new PrismaClient({ log: ["error", "warn"] });
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = devClient;

export const db = devClient;
