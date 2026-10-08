// MEKANIX — Prisma Client
// Standard PrismaClient for both dev and Cloudflare.
// D1 integration will be added in a follow-up once OpenNext
// fully supports the D1 context for Pages.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: ["error", "warn"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
