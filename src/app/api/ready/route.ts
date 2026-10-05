import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/ready — readiness check (different from liveness)
// /api/health = is the process alive + are dependencies up? (always 200 if running, 503 if deps down)
// /api/ready  = is the app ready to serve requests? (DB reachable + migrations applied)
//
// Use this for Kubernetes / docker readiness probes:
//   - liveness probe  → /api/health  (restart container if down)
//   - readiness probe → /api/ready   (remove from load balancer if not ready)
//
// Returns HTTP 200 if ready, 503 if not ready.

export async function GET() {
  const ready = {
    ok: true,
    timestamp: new Date().toISOString(),
    checks: {
      database: false,
      migrationsApplied: false,
    },
  };

  // Critical: database must be reachable
  try {
    await db.$queryRaw`SELECT 1`;
    ready.checks.database = true;
  } catch {
    ready.ok = false;
  }

  // Critical: migrations must be applied (otherwise schema mismatch → runtime errors)
  try {
    const result = await db.$queryRaw`SELECT count(*)::int as count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL` as any[];
    if (result[0]?.count > 0) {
      ready.checks.migrationsApplied = true;
    } else {
      ready.ok = false;
    }
  } catch {
    // _prisma_migrations table doesn't exist (e.g. SQLite dev with db push, not migrate)
    // In production (PostgreSQL + prisma migrate deploy) this table must exist.
    ready.ok = false;
  }

  const status = ready.ok ? 200 : 503;
  return NextResponse.json(ready, { status });
}
