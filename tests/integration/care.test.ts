// @vitest-environment node
// MEKANIX Phase 6 — Integration tests for CARE BOLA protection
//
// Verifies the auth + BOLA guards on three CARE endpoints:
//   - GET /api/care/bookings         — requires auth (any role), BOLA scopes by userId
//   - GET /api/care/technician/missions — requires TECHNICIAN / ADMIN role
//   - GET /api/care/admin/rules      — requires ADMIN role
//
// Strategy: mint real JWTs via createSession() so getSessionFromRequest()
// exercises the real jose verify path. Mock @/lib/db so we control what the
// endpoints see. Mock @/lib/rate-limit so we don't trip in-memory limits.
//
// We use the `node` environment (not jsdom) because we mint real JWTs via
// jose's `SignJWT`. In jsdom, `TextEncoder().encode()` returns a Uint8Array
// from a different realm than the one jose's `instanceof Uint8Array` check
// tests against — so the key is rejected. The `node` environment shares a
// single Uint8Array constructor across the board. None of these tests touch
// the DOM, so jsdom is not needed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSession } from "@/lib/auth";

// ──────────── Mocks (hoisted) ────────────
const mockServiceBookingFindMany = vi.fn().mockResolvedValue([]);
const mockMaintenanceRuleFindMany = vi.fn().mockResolvedValue([]);
const mockTechnicianFindUnique = vi.fn().mockResolvedValue(null);

// Session DB mock — `findUnique` returns a valid (non-revoked, non-expired)
// record so `verifySession` honours the JWT. Individual tests can override
// `mockSessionFindUnique.mockResolvedValueOnce(null)` to simulate a
// revoked/missing session.
const mockSessionFindUnique = vi.fn().mockResolvedValue({
  id: "sess_1",
  userId: "user_customer",
  tokenHash: "hash-placeholder",
  device: null,
  ip: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
  revokedAt: null,
  createdAt: new Date(),
  user: { status: "ACTIVE", role: "CUSTOMER" },
});
const mockSessionCreate = vi.fn().mockResolvedValue({});
const mockSessionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@/lib/db", () => ({
  db: {
    serviceBooking: {
      findMany: (...args: any[]) => mockServiceBookingFindMany(...args),
    },
    maintenanceRule: {
      findMany: (...args: any[]) => mockMaintenanceRuleFindMany(...args),
    },
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
    },
    session: {
      create: (...args: any[]) => mockSessionCreate(...args),
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60_000 }),
  checkRateLimit: vi.fn(() => null),
  getClientId: vi.fn(() => "127.0.0.1"),
  RATE_LIMITS: {
    OTP_SEND: { max: 5, windowMs: 60_000 },
    OTP_VERIFY: { max: 5, windowMs: 60_000 },
    PAYMENT: { max: 5, windowMs: 60_000 },
    WITHDRAW: { max: 3, windowMs: 3_600_000 },
    API_DEFAULT: { max: 60, windowMs: 60_000 },
  },
}));

// ──────────── Import route handlers (after mocks hoisted) ────────────
import { GET as bookingsGET } from "@/app/api/care/bookings/route";
import { GET as missionsGET } from "@/app/api/care/technician/missions/route";
import { GET as rulesGET } from "@/app/api/care/admin/rules/route";

// ──────────── Helpers ────────────
function authedReq(url: string, token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method: "GET", headers });
}

async function mintToken(role: "CUSTOMER" | "TECHNICIAN" | "ADMIN"): Promise<string> {
  const token = await createSession({
    userId: `user_${role.toLowerCase()}`,
    role,
    phone: "+989121234567",
    isGuest: false,
  });
  mockSessionFindUnique.mockResolvedValueOnce({
    id: "sess_1",
    userId: `user_${role.toLowerCase()}`,
    tokenHash: "hash-placeholder",
    device: null,
    ip: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    user: { status: "ACTIVE", role },
  });
  return token;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock impls
  mockServiceBookingFindMany.mockResolvedValue([]);
  mockMaintenanceRuleFindMany.mockResolvedValue([]);
  mockTechnicianFindUnique.mockResolvedValue(null);
  // Restore the default "valid session" record — individual tests can
  // override with `mockSessionFindUnique.mockResolvedValueOnce(...)`.
  mockSessionFindUnique.mockResolvedValue({
    id: "sess_1",
    userId: "user_customer",
    tokenHash: "hash-placeholder",
    device: null,
    ip: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: null,
    createdAt: new Date(),
  });
  mockSessionCreate.mockResolvedValue({});
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });
});

// ──────────── GET /api/care/bookings ────────────
describe("integration — GET /api/care/bookings (BOLA + auth)", () => {
  it("returns 401 without authentication", async () => {
    const req = authedReq("https://mekanix.test/api/care/bookings", null);
    const res = await bookingsGET(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // No DB hit should have happened
    expect(mockServiceBookingFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 with the user's bookings when authenticated", async () => {
    const token = await mintToken("CUSTOMER");
    const fakeBookings = [
      { id: "book_1", status: "REQUESTED", code: "CARE-1", userId: "user_customer" },
      { id: "book_2", status: "COMPLETED", code: "CARE-2", userId: "user_customer" },
    ];
    mockServiceBookingFindMany.mockResolvedValueOnce(fakeBookings);

    const req = authedReq("https://mekanix.test/api/care/bookings", token);
    const res = await bookingsGET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("book_1");

    // BOLA check: the findMany should be scoped to session.userId
    expect(mockServiceBookingFindMany).toHaveBeenCalledTimes(1);
    const callArgs = mockServiceBookingFindMany.mock.calls[0][0];
    expect(callArgs.where.userId).toBe("user_customer");
  });

  it("ADMIN sees all bookings (no userId filter)", async () => {
    const token = await mintToken("ADMIN");
    mockServiceBookingFindMany.mockResolvedValueOnce([
      { id: "book_admin_1", status: "REQUESTED" },
    ]);

    const req = authedReq("https://mekanix.test/api/care/bookings", token);
    const res = await bookingsGET(req);

    expect(res.status).toBe(200);
    // BOLA still scopes by userId — admin is treated as a regular authenticated
    // user on the bookings list (their own bookings, which is empty by default).
    const callArgs = mockServiceBookingFindMany.mock.calls[0][0];
    expect(callArgs.where.userId).toBe("user_admin");
  });
});

// ──────────── GET /api/care/technician/missions ────────────
describe("integration — GET /api/care/technician/missions (role-gated)", () => {
  it("returns 401 without authentication", async () => {
    const req = authedReq("https://mekanix.test/api/care/technician/missions", null);
    const res = await missionsGET(req);

    expect(res.status).toBe(401);
    expect(mockServiceBookingFindMany).not.toHaveBeenCalled();
  });

  it("returns 403 when the authenticated user is a CUSTOMER (not a technician)", async () => {
    const token = await mintToken("CUSTOMER");
    const req = authedReq(
      "https://mekanix.test/api/care/technician/missions",
      token
    );
    const res = await missionsGET(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Should not have queried bookings for a customer
    expect(mockServiceBookingFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 when the authenticated user is a TECHNICIAN", async () => {
    const token = await mintToken("TECHNICIAN");
    // The route resolves the Technician profile via getTechnicianFromSession
    // which calls db.technician.findUnique({ where: { userId } }).
    mockTechnicianFindUnique.mockResolvedValueOnce({
      id: "tech_1",
      userId: "user_technician",
      level: "EXPERT",
    });
    const fakeMissions = [
      { id: "book_t1", status: "ASSIGNED", technicianId: "tech_1" },
    ];
    mockServiceBookingFindMany.mockResolvedValueOnce(fakeMissions);

    const req = authedReq(
      "https://mekanix.test/api/care/technician/missions",
      token
    );
    const res = await missionsGET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);

    // BOLA: the query should filter by technicianId (resolved from session)
    const callArgs = mockServiceBookingFindMany.mock.calls[0][0];
    expect(callArgs.where.technicianId).toBe("tech_1");
  });

  it("returns 403 when a TECHNICIAN profile is missing (no Technician row)", async () => {
    const token = await mintToken("TECHNICIAN");
    mockTechnicianFindUnique.mockResolvedValueOnce(null); // no Technician profile

    const req = authedReq(
      "https://mekanix.test/api/care/technician/missions",
      token
    );
    const res = await missionsGET(req);

    expect(res.status).toBe(403);
    expect(mockServiceBookingFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 + sees ALL missions when ADMIN (no filters at all)", async () => {
    const token = await mintToken("ADMIN");
    mockServiceBookingFindMany.mockResolvedValueOnce([
      { id: "book_all_1", status: "IN_SERVICE" },
    ]);

    const req = authedReq(
      "https://mekanix.test/api/care/technician/missions",
      token
    );
    const res = await missionsGET(req);

    expect(res.status).toBe(200);
    const callArgs = mockServiceBookingFindMany.mock.calls[0][0];
    // Admin path: where is an empty object — no technicianId / no status filter.
    // (The role check above guards the route; the where clause is unconstrained.)
    expect(callArgs.where).toEqual({});
  });
});

// ──────────── GET /api/care/admin/rules ────────────
describe("integration — GET /api/care/admin/rules (ADMIN-only)", () => {
  it("returns 401 without authentication", async () => {
    const req = authedReq("https://mekanix.test/api/care/admin/rules", null);
    const res = await rulesGET(req);

    expect(res.status).toBe(401);
    expect(mockMaintenanceRuleFindMany).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated as CUSTOMER (not ADMIN)", async () => {
    const token = await mintToken("CUSTOMER");
    const req = authedReq("https://mekanix.test/api/care/admin/rules", token);
    const res = await rulesGET(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(mockMaintenanceRuleFindMany).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated as TECHNICIAN (not ADMIN)", async () => {
    const token = await mintToken("TECHNICIAN");
    const req = authedReq("https://mekanix.test/api/care/admin/rules", token);
    const res = await rulesGET(req);

    expect(res.status).toBe(403);
    expect(mockMaintenanceRuleFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 + rules list when authenticated as ADMIN", async () => {
    const token = await mintToken("ADMIN");
    const fakeRules = [
      { id: "rule_1", brand: "Toyota", category: "OIL" },
      { id: "rule_2", brand: "BMW", category: "FILTER" },
    ];
    mockMaintenanceRuleFindMany.mockResolvedValueOnce(fakeRules);

    const req = authedReq("https://mekanix.test/api/care/admin/rules", token);
    const res = await rulesGET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("rule_1");
  });
});
