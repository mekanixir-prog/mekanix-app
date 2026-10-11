import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/health — health check (200 if DB is reachable, 503 if not)
// Returns service metadata + DB check.
export async function GET() {
  let dbStatus: "healthy" | "unhealthy" = "unhealthy";
  try {
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
      uptime: process.uptime ? Math.floor(process.uptime()) : 0,
    },
    { status: ok ? 200 : 503 }
  );
}
