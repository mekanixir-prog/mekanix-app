// @vitest-environment node
// MEKANIX B-4 — Backend Security Auditor — Negative Tests
// ============================================================================
// Agent 4 (Backend Security Auditor) — Task ID B-4
//
// These are NEGATIVE security tests: they attempt cross-tenant access,
// privilege escalation, and unauthenticated mutations against the REAL route
// handlers. The DB access layer + rate-limit are mocked at the boundary; all
// authz helpers (requireAuth, requireJobParticipant, requireVehicleOwner,
// requireBookingParticipant, requireRole, getAdminFromRequest) run REAL.
//
// Test design follows tests/unit/wallets-withdraw.test.ts: real JWTs are
// minted via `createSession()` so `verifySession` exercises its full JWT
// verify + DB session lookup path. Each test sets up the specific DB records
// the authz helper needs to make its decision.
//
// If a test FAILS (route returns 200 instead of 401/403/404), that's a real
// BOLA / IDOR / auth-bypass finding — flagged in docs/AUDIT_SECURITY.md.
//
// Scope (per B-4 task spec):
//   1. Customer A cannot read Customer B's invoice/job/vehicle by direct id
//   2. Technician A cannot mutate Technician B's job status
//   3. Non-admin cannot reach admin resource routes (401/403)
//   4. OTP verify does not reveal phone existence (identical error shape)
//   5. Withdraw without session returns 401
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSession } from "@/lib/auth";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
//
// The DB mock provides every model touched by any route under test. Each
// model's methods are vi.fn()s that tests configure per-scenario via
// mockResolvedValueOnce. The authz helpers (auth.ts, care-auth.ts,
// admin-auth.ts) call these methods for real — we do NOT mock the helpers.
//
// The session mock is set up in beforeEach to return a valid (non-revoked,
// non-expired) record for ANY tokenHash query. This lets `verifySession`
// pass for whatever JWT we mint via `createSession()`.

const mockJobFindUnique = vi.fn();
const mockCustomerFindUnique = vi.fn();
const mockCustomerCreate = vi.fn();
const mockTechnicianFindUnique = vi.fn();
const mockVehicleFindUnique = vi.fn();
const mockInvoiceFindUnique = vi.fn();
const mockOtpCodeUpdateMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserFindMany = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockSessionFindUnique = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionUpdateMany = vi.fn();
const mockMechanicApplicationFindUnique = vi.fn();
const mockServicePackageFindMany = vi.fn();
const mockAdminUserCount = vi.fn();
const mockAdminUserFindFirst = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    job: { findUnique: (...args: any[]) => mockJobFindUnique(...args) },
    customer: {
      findUnique: (...args: any[]) => mockCustomerFindUnique(...args),
      create: (...args: any[]) => mockCustomerCreate(...args),
    },
    technician: { findUnique: (...args: any[]) => mockTechnicianFindUnique(...args) },
    vehicle: { findUnique: (...args: any[]) => mockVehicleFindUnique(...args) },
    invoice: { findUnique: (...args: any[]) => mockInvoiceFindUnique(...args) },
    otpCode: { updateMany: (...args: any[]) => mockOtpCodeUpdateMany(...args) },
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
      create: (...args: any[]) => mockUserCreate(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
    session: {
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      create: (...args: any[]) => mockSessionCreate(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
    mechanicApplication: {
      findUnique: (...args: any[]) => mockMechanicApplicationFindUnique(...args),
    },
    servicePackage: { findMany: (...args: any[]) => mockServicePackageFindMany(...args) },
    adminUser: {
      count: (...args: any[]) => mockAdminUserCount(...args),
      findFirst: (...args: any[]) => mockAdminUserFindFirst(...args),
    },
    notification: { create: vi.fn().mockResolvedValue({}) },
  })),
}));

// Mock rate-limit so the per-IP / per-user budgets don't run out across tests.
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, resetMs: 60_000 })),
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60_000 }),
  checkRateLimit: vi.fn(() => null),
  getClientId: vi.fn(() => "127.0.0.1"),
  RATE_LIMITS: {
    OTP_SEND: { max: 5, windowMs: 10 * 60_000 },
    OTP_VERIFY: { max: 5, windowMs: 60_000 },
    PAYMENT: { max: 5, windowMs: 60_000 },
    WITHDRAW: { max: 3, windowMs: 3_600_000 },
    API_DEFAULT: { max: 60, windowMs: 60_000 },
  },
}));

// ──────────── Import route handlers (after mocks hoisted) ────────────
import { GET as invoicesGET } from "@/app/api/invoices/route";
import { GET as jobsDetailGET } from "@/app/api/jobs/[id]/route";
import { PATCH as vehiclesPATCH } from "@/app/api/vehicles/[id]/route";
import { PATCH as jobStatusPATCH } from "@/app/api/jobs/[id]/status/route";
import { GET as adminResourceGET } from "@/app/api/admin/[resource]/route";
import { GET as careAdminPackagesGET } from "@/app/api/care/admin/packages/route";
import { POST as mechanicApprovePOST } from "@/app/api/mechanic-applications/[id]/approve/route";
import { POST as otpVerifyPOST } from "@/app/api/auth/otp/verify/route";
import { POST as withdrawPOST } from "@/app/api/wallets/withdraw/route";

// ──────────── Helpers ────────────
function jsonReq(
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function mintUserToken(
  userId: string,
  role: "CUSTOMER" | "TECHNICIAN" | "ADMIN" | "FLEET_MANAGER" | "PARTNER",
  phone: string | null = null,
): Promise<string> {
  return createSession({ userId, role, phone, isGuest: false });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: any session lookup returns a valid (non-revoked, non-expired)
  // record. verifySession builds the Session object from the JWT payload
  // (not from this record), so the userId here doesn't matter — only the
  // existence + revokedAt=null + expiresAt>now fields matter.
  mockSessionFindUnique.mockResolvedValue({
    id: "sess_test",
    userId: "any",
    tokenHash: "any",
    device: null,
    ip: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // tomorrow
    revokedAt: null,
    createdAt: new Date(),
  });
  mockSessionCreate.mockResolvedValue({});
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockCustomerCreate.mockResolvedValue({});
});

// ============================================================================
// 1. Customer A cannot read Customer B's invoice/job/vehicle by direct id
// ============================================================================
describe("B-4 [BOLA] — Customer A cannot read Customer B's resources by direct id", () => {
  beforeEach(async () => {
    // Mint a real JWT for Customer A (user-a, CUSTOMER role).
    // createSession signs the JWT and inserts a Session DB row (mocked above).
    // verifySession will re-verify the JWT signature + query the session row.
  });

  it("rejects Customer A reading Customer B's job (GET /api/jobs/[id])", async () => {
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    // Customer A's profile (looked up via session.userId = "user-a")
    mockCustomerFindUnique.mockResolvedValue({ id: "cust-a", userId: "user-a" });
    // Customer B's job — requireJobParticipant will see customerId !== cust-a
    mockJobFindUnique.mockResolvedValue({
      id: "job-b",
      request: { customerId: "cust-b" },
      technicianId: "tech-b",
    });

    const req = jsonReq("GET", "http://localhost/api/jobs/job-b", token);
    const res = await jobsDetailGET(req, { params: Promise.resolve({ id: "job-b" }) });

    expect(res.status).toBe(403);
    // CRITICAL: the DB query for the full job record must NOT run (BOLA short-circuit)
    // requireJobParticipant internally calls db.job.findUnique with a minimal select,
    // but the route's full include query (line 26) must not execute.
    // We can't easily distinguish the two calls, but the 403 status proves the gate worked.
  });

  it("rejects Customer A reading Customer B's invoice (GET /api/invoices?jobId=job-b)", async () => {
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    mockCustomerFindUnique.mockResolvedValue({ id: "cust-a", userId: "user-a" });
    mockJobFindUnique.mockResolvedValue({
      id: "job-b",
      request: { customerId: "cust-b" },
      technicianId: "tech-b",
    });

    const req = jsonReq("GET", "http://localhost/api/invoices?jobId=job-b", token);
    const res = await invoicesGET(req);

    expect(res.status).toBe(403);
    // Invoice query must NOT run — requireJobParticipant gate fires first.
    expect(mockInvoiceFindUnique).not.toHaveBeenCalled();
  });

  it("rejects Customer A editing Customer B's vehicle (PATCH /api/vehicles/[id])", async () => {
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    mockCustomerFindUnique.mockResolvedValue({ id: "cust-a", userId: "user-a" });
    // Vehicle owned by Customer B
    mockVehicleFindUnique.mockResolvedValue({ id: "veh-b", customerId: "cust-b" });

    const req = jsonReq("PATCH", "http://localhost/api/vehicles/veh-b", token, {
      make: "IKCO",
      model: "Samand",
    });
    const res = await vehiclesPATCH(req, { params: Promise.resolve({ id: "veh-b" }) });

    expect(res.status).toBe(403);
  });
});

// ============================================================================
// 2. Technician A cannot mutate Technician B's job status
// ============================================================================
describe("B-4 [BOLA] — Technician A cannot mutate Technician B's job status", () => {
  it("rejects Technician A from PATCHing Technician B's job (PATCH /api/jobs/[id]/status)", async () => {
    const token = await mintUserToken("techuser-a", "TECHNICIAN", "+989120000002");
    // Technician A's profile
    mockTechnicianFindUnique.mockResolvedValue({ id: "tech-a", userId: "techuser-a" });
    // Job assigned to Technician B (technicianId: "tech-b")
    mockJobFindUnique.mockResolvedValue({
      id: "job-b",
      request: { customerId: "cust-b" },
      technicianId: "tech-b",
    });

    const req = jsonReq(
      "PATCH",
      "http://localhost/api/jobs/job-b/status",
      token,
      { status: "COMPLETED" },
    );
    const res = await jobStatusPATCH(req, { params: Promise.resolve({ id: "job-b" }) });

    expect(res.status).toBe(403);
    // requireJobParticipant returned 403 — body parse + db.job.updateMany never run.
  });
});

// ============================================================================
// 3. Non-admin cannot reach admin resource routes (401/403)
// ============================================================================
describe("B-4 [Authz] — Non-admin cannot reach admin resource routes", () => {
  it("rejects unauthenticated GET /api/admin/[resource] with 401 (no Authorization header)", async () => {
    const req = jsonReq("GET", "http://localhost/api/admin/customers", null);
    const res = await adminResourceGET(req, {
      params: Promise.resolve({ resource: "customers" }),
    });

    expect(res.status).toBe(401);
    // Admin DB handler must NOT run
    expect(mockAdminUserCount).not.toHaveBeenCalled();
  });

  it("rejects user-JWT GET /api/admin/[resource] with 401 (dev-mode: admin secret differs from user secret)", async () => {
    // Mint a real user JWT (CUSTOMER role) — signed with the user-side dev secret.
    // verifyAdminToken uses a DIFFERENT dev secret ("mekanix-admin-dev-secret-change-me"),
    // so jwtVerify fails → adminSession = null → 401.
    //
    // NOTE: This test verifies DEV-mode isolation. In PRODUCTION, both secrets
    // collapse to process.env.JWT_SECRET (see admin-auth.ts:8 SEC-17), and a
    // user JWT WOULD pass verifyAdminToken — see SEC-21 finding in
    // docs/AUDIT_SECURITY.md (admin auth bypass via user JWT in production).
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    const req = jsonReq("GET", "http://localhost/api/admin/customers", token);
    const res = await adminResourceGET(req, {
      params: Promise.resolve({ resource: "customers" }),
    });

    expect(res.status).toBe(401);
    expect(mockAdminUserCount).not.toHaveBeenCalled();
  });

  it("rejects CUSTOMER GET /api/care/admin/packages with 403 (requireRole gate)", async () => {
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    const req = jsonReq("GET", "http://localhost/api/care/admin/packages", token);
    const res = await careAdminPackagesGET(req);

    expect(res.status).toBe(403);
    // Service packages query must NOT run — requireRole gate fires first.
    expect(mockServicePackageFindMany).not.toHaveBeenCalled();
  });

  it("rejects CUSTOMER POST /api/mechanic-applications/[id]/approve with 403 (requireRole gate)", async () => {
    const token = await mintUserToken("user-a", "CUSTOMER", "+989120000001");
    const req = jsonReq(
      "POST",
      "http://localhost/api/mechanic-applications/app-1/approve",
      token,
      {},
    );
    const res = await mechanicApprovePOST(req, {
      params: Promise.resolve({ id: "app-1" }),
    });

    expect(res.status).toBe(403);
    // Application lookup must NOT run — requireRole gate fires first.
    expect(mockMechanicApplicationFindUnique).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. OTP verify does not reveal phone existence (identical error shape)
// ============================================================================
describe("B-4 [Info disclosure] — OTP verify does not reveal phone existence", () => {
  it("returns identical 400 for KNOWN phone + wrong code", async () => {
    // No Authorization header needed — OTP verify is unauthenticated (by design).
    // Mock db.otpCode.updateMany to return count=0 — no valid unconsumed code
    // matches the (phone, codeHash) pair. The route returns 400 immediately,
    // WITHOUT touching the User table (so no O(n) scan, no existence signal).
    mockOtpCodeUpdateMany.mockResolvedValue({ count: 0 });

    const req = jsonReq(
      "POST",
      "http://localhost/api/auth/otp/verify",
      null,
      { phone: "+989120000001", code: "000000" }, // known phone, wrong code
    );
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired code");
    // The user-lookup / O(n) scan must NOT run when the code is invalid.
    // Route guard: consumed.count === 0 → return 400 before user.findUnique.
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockUserFindMany).not.toHaveBeenCalled();
  });

  it("returns identical 400 for UNKNOWN phone + wrong code", async () => {
    mockOtpCodeUpdateMany.mockResolvedValue({ count: 0 });

    const req = jsonReq(
      "POST",
      "http://localhost/api/auth/otp/verify",
      null,
      { phone: "+989129999999", code: "000000" }, // unknown phone, wrong code
    );
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired code");
    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockUserFindMany).not.toHaveBeenCalled();
  });

  it("known-vs-unknown phone responses are identical (status + error message)", async () => {
    // Run both requests and compare. Enumeration is only prevented if the
    // response shape is byte-identical (same status, same body keys, same
    // error string). A timing difference would also be a signal — but we
    // can't easily assert timing in a unit test; the consumed.count === 0
    // early-return makes timing uniform in practice.
    mockOtpCodeUpdateMany.mockResolvedValue({ count: 0 });

    const res1 = await otpVerifyPOST(
      jsonReq("POST", "http://localhost/api/auth/otp/verify", null, {
        phone: "+989120000001",
        code: "000000",
      }),
    );
    const res2 = await otpVerifyPOST(
      jsonReq("POST", "http://localhost/api/auth/otp/verify", null, {
        phone: "+989129999999",
        code: "000000",
      }),
    );

    expect(res1.status).toBe(res2.status);
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    const body2 = await res2.json();
    // Same error message — no "phone not found" vs "wrong code" distinction.
    expect(body1.error).toBe(body2.error);
    expect(body1.error).toBe("Invalid or expired code");
    // No other keys in the body that could leak (e.g., `phoneExists: true`)
    expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort());
    expect(Object.keys(body1).sort()).toEqual(["error"]);
  });
});

// ============================================================================
// 5. Withdraw without session returns 401
// ============================================================================
describe("B-4 [Authn] — Withdraw without session returns 401", () => {
  it("rejects POST /api/wallets/withdraw with no Authorization header (401)", async () => {
    // No Authorization header, no cookie. requireAuth → getSessionFromRequest
    // returns null → NextResponse(401). The route returns it immediately —
    // before the role check, balance check, or any DB write.
    const req = jsonReq(
      "POST",
      "http://localhost/api/wallets/withdraw",
      null,
      { amount: 500, method: "card" },
    );
    const res = await withdrawPOST(req);

    expect(res.status).toBe(401);
    // CRITICAL: no wallet lookup, no balance check, no withdrawal request.
    expect(mockTechnicianFindUnique).not.toHaveBeenCalled();
  });

  it("rejects POST /api/wallets/withdraw with malformed Authorization header (401)", async () => {
    // "Bearer " prefix is required by getSessionFromRequest; a bare token or
    // a different scheme must be rejected.
    const req = new Request("http://localhost/api/wallets/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Basic abc123", // not Bearer
      },
      body: JSON.stringify({ amount: 500 }),
    });
    const res = await withdrawPOST(req);

    expect(res.status).toBe(401);
    expect(mockTechnicianFindUnique).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SEC-21 regression — admin auth bypass via user JWT (production collision)
// Agent 1 (coordinator) fix verification. Task ID: FIX-SEC-21.
//
// Before the fix, `verifyAdminToken` accepted any token signed with
// JWT_SECRET, and in production admin + user secrets collide, so a user JWT
// (role CUSTOMER, no adminId) was accepted as an admin session.
//
// After the fix, two layers reject a user-shaped JWT:
//   (1) payload validation: adminId must be non-empty string, role ∈ {ADMIN,SUPER_ADMIN}
//   (2) secret separation via ADMIN_JWT_SECRET (when set)
// ────────────────────────────────────────────────────────────────────────────
describe("SEC-21: admin auth rejects user-shaped JWTs", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects a user JWT (role CUSTOMER) even when secrets collide", async () => {
    vi.stubEnv("JWT_SECRET", "shared-secret-for-collision-test");
    vi.stubEnv("ADMIN_JWT_SECRET", ""); // force fallback to shared JWT_SECRET
    vi.stubEnv("NODE_ENV", "production");

    const { createSession } = await import("@/lib/auth");
    const { verifyAdminToken } = await import("@/lib/admin-auth");

    // Mint a USER session token (role CUSTOMER, signed with JWT_SECRET).
    const userToken = await createSession({
      userId: "user-123",
      phone: "09120000000",
      role: "CUSTOMER",
      isGuest: false,
    });

    // Even though the signing secret matches the admin fallback, the payload
    // shape (no adminId, role CUSTOMER) MUST be rejected.
    const result = await verifyAdminToken(userToken);
    expect(result).toBeNull();
  });

  it("rejects a user JWT when ADMIN_JWT_SECRET is set (full secret isolation)", async () => {
    vi.stubEnv("JWT_SECRET", "user-secret");
    vi.stubEnv("ADMIN_JWT_SECRET", "admin-secret-different-with-at-least-32-bytes");
    vi.stubEnv("NODE_ENV", "production");

    const { createSession } = await import("@/lib/auth");
    const { verifyAdminToken, createAdminToken } = await import("@/lib/admin-auth");

    const userToken = await createSession({
      userId: "user-456",
      phone: "09120000001",
      role: "CUSTOMER",
      isGuest: false,
    });

    // Layer 1: signature mismatch (user secret ≠ admin secret) → jwtVerify throws.
    expect(await verifyAdminToken(userToken)).toBeNull();

    // Sanity: a real admin token (signed with admin secret, valid payload) IS accepted.
    const adminToken = await createAdminToken({
      adminId: "admin-1",
      username: "admin",
      role: "SUPER_ADMIN",
    });
    const adminSession = await verifyAdminToken(adminToken);
    expect(adminSession).not.toBeNull();
    expect(adminSession?.adminId).toBe("admin-1");
    expect(adminSession?.role).toBe("SUPER_ADMIN");
  });

  it("rejects a forged admin token with a valid-but-non-admin role", async () => {
    // Even if an attacker signs a token with the admin secret but sets
    // role to CUSTOMER (or omits adminId), it must be rejected.
    vi.stubEnv("ADMIN_JWT_SECRET", "admin-secret-different-with-at-least-32-bytes");
    vi.stubEnv("JWT_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");

    const { SignJWT } = await import("jose");
    const { verifyAdminToken } = await import("@/lib/admin-auth");

    const forged = await new SignJWT({ adminId: "x", username: "y", role: "CUSTOMER" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode("admin-secret-different-with-at-least-32-bytes"));

    expect(await verifyAdminToken(forged)).toBeNull();
  });
});
