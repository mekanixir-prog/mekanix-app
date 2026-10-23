import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/health — health check (200 if DB is reachable, 503 if not)
// Returns service metadata + DB check.
//
// $queryRaw`SELECT 1` compatibility note:
//   The Prisma D1 adapter (@prisma/adapter-d1@6.19.3) implements queryRaw
//   (routes through D1Database.prepare("SELECT 1").all()). So $queryRaw IS
//   compatible with D1 — but only when the PrismaClient is created with the
//   PrismaD1 adapter (via getDbForLib → db-worker.ts). Previously this route
//   used the sync `db` import (a stub in Workers), so the health check would
//   always report "unhealthy" in Workers even when D1 was reachable.
export async function GET() {
  let dbStatus: "healthy" | "unhealthy" = "unhealthy";
  try {
    const db = await getDbForLib();
    await db.$queryRaw`SELECT 1`;
    dbStatus = "healthy";
  } catch {
    dbStatus = "unhealthy";
  }

  const ok = dbStatus === "healthy";
  return NextResponse.json(
    {
      ok,
      message: ok ? "MEKANIX is running" : "Database unreachable",
      services: {
        database: dbStatus,
        redis: "not-configured",
        sms: process.env.SMS_PROVIDER ?? "console",
        eta: "simulator",
      },
      timestamp: new Date().toISOString(),
      uptime: typeof process !== "undefined" && process.uptime ? Math.floor(process.uptime()) : 0,
    },
    { status: ok ? 200 : 503 }
  );
}
