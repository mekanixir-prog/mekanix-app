// @vitest-environment node
// MEKANIX — SEC-11 Timeline BOLA Tests (Bundle 3)
// ============================================================================
// Verifies the SEC-11 fix in src/app/api/care/bookings/[id]/timeline/route.ts.
//
// The fix adds `requireBookingParticipant` AFTER `requireAuth` and BEFORE the
// DB query that reads timeline events. Without this, any authenticated user
// could read another user's booking timeline by guessing/enumerating the
// booking id (cross-tenant disclosure — a BOLA / IDOR vulnerability).
//
// Tests:
//   1. Returns 403 when requireBookingParticipant returns an error response
//      (caller is not a participant of the booking)
//   2. Returns 200 with events when requireBookingParticipant returns null
//      (caller is a participant — owner, assigned technician, or admin)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockServiceTimelineEventFindMany = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    serviceTimelineEvent: {
      findMany: (...args: any[]) => mockServiceTimelineEventFindMany(...args),
    },
  })),
}));

// Mock requireAuth — controllable per-test
const mockRequireAuth = vi.fn();
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));

// Mock requireBookingParticipant — controllable per-test
const mockRequireBookingParticipant = vi.fn();
vi.mock("@/lib/care-auth", () => ({
  requireBookingParticipant: (...args: any[]) => mockRequireBookingParticipant(...args),
}));

// ──────────── Import route handler (after mocks hoisted) ────────────
import { GET } from "@/app/api/care/bookings/[id]/timeline/route";

// ──────────── Helpers ────────────
function makeGetRequest(bookingId: string): Request {
  return new Request(`http://localhost/api/care/bookings/${bookingId}/timeline`, {
    method: "GET",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated CUSTOMER session
  mockRequireAuth.mockResolvedValue({
    userId: "user-1",
    role: "CUSTOMER",
    phone: "+989120000000",
    isGuest: false,
  });
});

describe("SEC-11 — /api/care/bookings/[id]/timeline BOLA protection", () => {
  // ──────────── 1. Non-participant → 403 ────────────
  it("returns 403 when requireBookingParticipant returns an error (non-participant)", async () => {
    // requireBookingParticipant returns a NextResponse(403) — the caller is
    // not a participant of this booking.
    mockRequireBookingParticipant.mockResolvedValueOnce(
      NextResponse.json({ error: "دسترسی به این سفارش مجاز نیست" }, { status: 403 })
    );

    const req = makeGetRequest("booking-other-user");
    const res = await GET(req, { params: Promise.resolve({ id: "booking-other-user" }) });

    expect(res.status).toBe(403);

    // CRITICAL BOLA invariant: the DB query must NOT run when the caller is
    // not a participant. Without this check, the events would be returned
    // to any authenticated user.
    expect(mockServiceTimelineEventFindMany).not.toHaveBeenCalled();
  });

  // ──────────── 2. Participant → 200 with events ────────────
  it("returns 200 with events when requireBookingParticipant returns null (participant)", async () => {
    // requireBookingParticipant returns null — caller IS a participant
    mockRequireBookingParticipant.mockResolvedValueOnce(null);
    const events = [
      { id: "ev-1", bookingId: "booking-1", timestamp: "2026-01-01T00:00:00Z", type: "CREATED", message: "Booking created" },
      { id: "ev-2", bookingId: "booking-1", timestamp: "2026-01-01T00:05:00Z", type: "ASSIGNED", message: "Technician assigned" },
    ];
    mockServiceTimelineEventFindMany.mockResolvedValueOnce(events);

    const req = makeGetRequest("booking-1");
    const res = await GET(req, { params: Promise.resolve({ id: "booking-1" }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("ev-1");
    expect(body[1].id).toBe("ev-2");

    // The DB query WAS called (caller is authorized)
    expect(mockServiceTimelineEventFindMany).toHaveBeenCalledTimes(1);
    const findManyArgs = mockServiceTimelineEventFindMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ bookingId: "booking-1" });
    expect(findManyArgs.orderBy).toEqual({ timestamp: "asc" });
  });

  // ──────────── Extra: 403 from requireBookingParticipant short-circuits ────────────
  it("does not call findMany even when requireBookingParticipant returns 404 (booking not found)", async () => {
    // requireBookingParticipant can return 404 when booking doesn't exist
    // (the function checks the booking in DB before authorizing).
    mockRequireBookingParticipant.mockResolvedValueOnce(
      NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 })
    );

    const req = makeGetRequest("booking-missing");
    const res = await GET(req, { params: Promise.resolve({ id: "booking-missing" }) });

    expect(res.status).toBe(404);
    expect(mockServiceTimelineEventFindMany).not.toHaveBeenCalled();
  });

  // ──────────── Extra: ADMIN always passes (requireBookingParticipant returns null) ────────────
  it("allows ADMIN to read any booking timeline (admin bypass)", async () => {
    mockRequireAuth.mockResolvedValueOnce({
      userId: "admin-1",
      role: "ADMIN",
      phone: null,
      isGuest: false,
    });
    mockRequireBookingParticipant.mockResolvedValueOnce(null);
    mockServiceTimelineEventFindMany.mockResolvedValueOnce([
      { id: "ev-1", bookingId: "booking-any", timestamp: "2026-01-01T00:00:00Z", type: "CREATED" },
    ]);

    const req = makeGetRequest("booking-any");
    const res = await GET(req, { params: Promise.resolve({ id: "booking-any" }) });

    expect(res.status).toBe(200);
    expect(mockServiceTimelineEventFindMany).toHaveBeenCalledTimes(1);
  });

  // ──────────── Extra: unauthenticated → 401 from requireAuth ────────────
  it("returns 401 when requireAuth returns a NextResponse (unauthenticated)", async () => {
    mockRequireAuth.mockResolvedValueOnce(
      NextResponse.json({ error: "unauthorized" }, { status: 401 })
    );

    const req = makeGetRequest("booking-1");
    const res = await GET(req, { params: Promise.resolve({ id: "booking-1" }) });

    expect(res.status).toBe(401);
    // Auth check happens before BOLA check
    expect(mockRequireBookingParticipant).not.toHaveBeenCalled();
    expect(mockServiceTimelineEventFindMany).not.toHaveBeenCalled();
  });
});
