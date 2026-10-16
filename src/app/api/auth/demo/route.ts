import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/auth/demo
// DEV-ONLY endpoint that returns demo users for one-click sign-in.
// This endpoint is completely disabled in production builds.
// In production, this returns 404 immediately (no DB query, no data exposure).
//
// Per ARCHITECTURE.md §6, this route should additionally be stripped from
// production deployments via `next.config.ts` rewrites (or middleware) that
// short-circuit /api/auth/demo/* → 404 before the route handler ever runs.
// The handler-level guard below is a defense-in-depth measure.

const TECHNICIAN_INCLUDE = {
  specialties: true,
  certifications: true,
  serviceAreas: true,
} as const;

export async function GET() {
  // Hard block in production — no DB access at all. Return a bare 404 so an
  // attacker can't even fingerprint the route (no JSON body, no headers
  // beyond the default NextResponse ones).
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // ── DEV-ONLY: build the demo sign-in payload ──
  const db = await getDbForLib();
  const customer = await db.user.findFirst({
    where: { role: "CUSTOMER" },
    include: { customer: true },
    orderBy: { createdAt: "asc" },
  });
  const technician = await db.user.findFirst({
    where: { role: "TECHNICIAN" },
    include: { technician: { include: TECHNICIAN_INCLUDE } },
    orderBy: { createdAt: "asc" },
  });
  const admin = await db.user.findFirst({ where: { role: "ADMIN" } });
  return NextResponse.json({ CUSTOMER: customer, TECHNICIAN: technician, ADMIN: admin });
}
