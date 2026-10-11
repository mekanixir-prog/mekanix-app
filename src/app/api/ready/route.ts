import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/ready — readiness probe (503 if DB is unreachable)
export async function GET() {
  const checks: Record<string, boolean> = {};
  const errors: string[] = [];

  // DB check
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (e: unknown) {
    checks.database = false;
    errors.push(e instanceof Error ? e.message : "DB check failed");
  }

  const ok = Object.values(checks).every(Boolean);
  return NextResponse.json(
    { ok, checks, errors, timestamp: new Date().toISOString() },
    { status: ok ? 200 : 503 }
  );
}
