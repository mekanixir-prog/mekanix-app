// MEKANIX — Unified Services list endpoint.
//
// GET /api/services
//
// Returns a unified list of services across BOTH underlying models:
//   - Job (on-demand repair)      — joined via Customer → ServiceRequest
//   - ServiceBooking (CARE)       — filtered by userId directly
//
// Query params:
//   - status  — comma-separated unified statuses (e.g. ?status=COMPLETED,CANCELLED)
//   - limit   — default 50, max 200
//   - offset  — default 0
//   - stats   — if "true", returns aggregate counts instead of a list
//   - lite    — if "true", returns the lite (low-bandwidth) shape
//
// This endpoint is ADDITIVE — existing /api/jobs and /api/care/bookings
// routes continue to work unchanged. New UI consumers that want a single
// "all my services" view should use this endpoint.

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-helpers";
import { getServicesForUser, getServiceStats } from "@/lib/service-unified";
import { wantsLite, liteResponse } from "@/lib/lite-response";

export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const stats = url.searchParams.get("stats") === "true";
  const lite = wantsLite(req);
  const statusParam = url.searchParams.get("status");
  const status = statusParam
    ? (statusParam.split(",").filter(Boolean) as any[])
    : undefined;
  const limit = Math.min(
    200,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50)
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10) || 0
  );

  // ?stats=true — return aggregate counts for dashboard tiles.
  if (stats) {
    const s = await getServiceStats(session.userId);
    return NextResponse.json(s);
  }

  const services = await getServicesForUser(session.userId, {
    status,
    limit,
    offset,
  });

  return NextResponse.json(liteResponse(services, lite));
}
