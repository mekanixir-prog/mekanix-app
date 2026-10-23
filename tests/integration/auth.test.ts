// @vitest-environment node
// MEKANIX Phase 6 — Integration tests for the OTP auth flow
//
// Tests the actual route handlers under src/app/api/auth/otp/* by calling POST()
// with mocked Request objects. The db module is mocked so we control OTP code
// records and user records; rate-limit is mocked so we don't trip in-memory
// rate limits across tests.
//
// We use the `node` environment (not jsdom) because the OTP verify route signs
// a JWT via jose's `SignJWT`. In jsdom, `TextEncoder().encode()` returns a
// Uint8Array from a different realm than the one jose's `instanceof Uint8Array`
// check tests against — so the key is rejected. The `node` environment shares
// a single Uint8Array constructor across the board. None of these tests touch
// the DOM, so jsdom is not needed.
//
// Covered:
//   - POST /api/auth/otp/send with valid phone → 200 + dev-mode `code` field
//   - POST /api/auth/otp/send with invalid phone (regex mismatch) → 400
//   - POST /api/auth/otp/send with missing phone → 400
//   - POST /api/auth/otp/verify with valid code → 200 + `user` object
//   - POST /api/auth/otp/verify with invalid code → 400
import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
//
// `vi.mock` is hoisted before any import statements, so the mock factories
// run before the route handlers are imported. Inside the factory we use
// `vi.fn()` so individual tests can override return values.

const mockOtpFindFirst = vi.fn();
const mockOtpUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
const mockOtpCreate = vi.fn().mockResolvedValue({});
const mockOtpUpdate = vi.fn().mockResolvedValue({});
const mockUserFindUnique = vi.fn();
const mockUserCreate = vi.fn();
const mockUserUpdate = vi.fn();
const mockUserFindMany = vi.fn().mockResolvedValue([]);
const mockCustomerCreate = vi.fn().mockResolvedValue({});
// Session DB mock — `createSession` now writes a Session row on login.
// We don't exercise verifySession in this file, so `findUnique` /
// `updateMany` are stubs to keep the mock shape complete.
const mockSessionCreate = vi.fn().mockResolvedValue({});
const mockSessionFindUnique = vi.fn().mockResolvedValue(null);
const mockSessionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@/lib/db", () => ({
  db: {
    otpCode: {
      findFirst: (...args: any[]) => mockOtpFindFirst(...args),
      updateMany: (...args: any[]) => mockOtpUpdateMany(...args),
      create: (...args: any[]) => mockOtpCreate(...args),
      update: (...args: any[]) => mockOtpUpdate(...args),
    },
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      findMany: (...args: any[]) => mockUserFindMany(...args),
      create: (...args: any[]) => mockUserCreate(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
    customer: {
      create: (...args: any[]) => mockCustomerCreate(...args),
    },
    session: {
      create: (...args: any[]) => mockSessionCreate(...args),
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
      updateMany: (...args: any[]) => mockSessionUpdateMany(...args),
    },
  },
}));

// Mock rate-limit so we don't accumulate in-memory counts across tests.
// `rateLimitAsync` is the Redis-backed version — mocked to always succeed so
// the OTP send/verify routes (which now call `await rateLimitAsync(...)`)
// don't trip across tests.
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

// ──────────── Import route handlers (after mocks are hoisted) ────────────
import { POST as otpSendPOST } from "@/app/api/auth/otp/send/route";
import { POST as otpVerifyPOST } from "@/app/api/auth/otp/verify/route";
import { hashOtpCode } from "@/lib/otp-crypto";
import { createHash } from "node:crypto";

// ──────────── Helpers ────────────
function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock implementations after each test
  mockOtpUpdateMany.mockResolvedValue({ count: 0 });
  mockOtpCreate.mockResolvedValue({});
  mockOtpUpdate.mockResolvedValue({});
  mockUserFindMany.mockResolvedValue([]);
  mockCustomerCreate.mockResolvedValue({});
  mockSessionCreate.mockResolvedValue({});
  mockSessionFindUnique.mockResolvedValue(null);
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });
});

// ──────────── POST /api/auth/otp/send ────────────
describe("integration — POST /api/auth/otp/send", () => {
  it("returns 200 with a `code` field in dev mode for a valid phone", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/send", {
      phone: "+989121234567",
    });
    const res = await otpSendPOST(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    // In non-production (vitest sets NODE_ENV=test) the route exposes the code
    // so the test UI can read it. Assert it's a 6-digit numeric string.
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.expiresAt).toBeTruthy();

    // The route should have invalidated previous codes + created a new one
    expect(mockOtpUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockOtpCreate).toHaveBeenCalledTimes(1);

    // SECURITY regression check: the plaintext `code` returned to the client
    // must NOT be what gets persisted to the DB. The DB column should hold
    // the SHA-256 hex digest (64 lowercase hex chars), so a read-only DB
    // leak cannot reveal usable codes.
    const createCall = mockOtpCreate.mock.calls[0][0] as {
      data: { phone: string; code: string; expiresAt: Date };
    };
    expect(createCall.data.phone).toBe("+989121234567");
    expect(createCall.data.code).toHaveLength(64);
    expect(createCall.data.code).toMatch(/^[0-9a-f]{64}$/);
    // The persisted hash must equal SHA-256(body.code) — i.e. the two
    // operations share the same hashing helper.
    expect(createCall.data.code).toBe(hashOtpCode(body.code));
    expect(createCall.data.code).toBe(
      createHash("sha256").update(body.code).digest("hex")
    );
    // And it must NOT be the plaintext code itself.
    expect(createCall.data.code).not.toBe(body.code);
  });

  it("accepts a phone with spaces / dashes (schema allows those, route strips them)", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/send", {
      phone: "+98 912-123-4567",
    });
    const res = await otpSendPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toMatch(/^\d{6}$/);
  });

  it("returns 400 for an invalid phone (regex mismatch)", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/send", {
      phone: "not-a-phone!!!",
    });
    const res = await otpSendPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Should not have created any OTP code
    expect(mockOtpCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for a phone shorter than 8 chars", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/send", {
      phone: "12345",
    });
    const res = await otpSendPOST(req);
    expect(res.status).toBe(400);
    expect(mockOtpCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when phone is missing from the body", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/send", {});
    const res = await otpSendPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(mockOtpCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = new Request("https://mekanix.test/api/auth/otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await otpSendPOST(req);
    expect(res.status).toBe(400);
    expect(mockOtpCreate).not.toHaveBeenCalled();
  });
});

// ──────────── POST /api/auth/otp/verify ────────────
describe("integration — POST /api/auth/otp/verify", () => {
  it("returns 200 + `user` object for a valid code + existing user", async () => {
    // Arrange: the atomic updateMany returns count=1 (one row matched the
    // WHERE clause: phone + code hash + consumed:false + not expired).
    // SEC-10 fix: route no longer calls findFirst + update separately;
    // a single conditional updateMany atomically transitions the code.
    mockOtpUpdateMany.mockResolvedValueOnce({ count: 1 });
    // Existing user with a customer record
    mockUserFindUnique.mockResolvedValueOnce({
      id: "user_1",
      phone: "+989121234567",
      phoneVerified: true,
      role: "CUSTOMER",
      name: "Daniel Reyes",
      customer: { id: "cust_1", userId: "user_1" },
      technician: null,
    });

    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989121234567",
      code: "123456",
    });
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeTruthy();
    expect(body.user.id).toBe("user_1");
    expect(body.user.phone).toBe("+989121234567");
    expect(body.created).toBe(false);

    // SEC-10 regression check: the OTP is consumed via a single atomic
    // updateMany call whose WHERE clause includes phone + code hash +
    // consumed:false + expiresAt > now. DATA sets consumed:true.
    expect(mockOtpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: "+989121234567",
          code: hashOtpCode("123456"),
          consumed: false,
          expiresAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
        data: expect.objectContaining({ consumed: true }),
      })
    );

    // The legacy findFirst + update pattern must NOT be used.
    expect(mockOtpFindFirst).not.toHaveBeenCalled();
    expect(mockOtpUpdate).not.toHaveBeenCalled();

    // SECURITY regression check: the verify route must hash the user-supplied
    // code with SHA-256 before looking it up — the DB column holds the hash,
    // not the plaintext code. Assert updateMany was called with the digest
    // (NOT the plaintext) in the WHERE clause.
    const updateManyCall = mockOtpUpdateMany.mock.calls[0][0] as {
      where: { code: string };
    };
    expect(updateManyCall.where.code).toBe(hashOtpCode("123456"));
    expect(updateManyCall.where.code).not.toBe("123456");

    // Session cookie should be set
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("mekanix-token=");

    // createSession should have written a Session DB row (userId + hashed
    // token + 30-day expiry). The tokenHash stored must NOT be the raw JWT
    // — it's a SHA-256 hex digest.
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockSessionCreate.mock.calls[0][0];
    expect(createArgs.data.userId).toBe("user_1");
    expect(createArgs.data.tokenHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(createArgs.data.tokenHash).not.toContain("."); // definitely not the JWT
    expect(createArgs.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(createArgs.data.expiresAt.getTime()).toBeLessThan(Date.now() + 31 * 24 * 60 * 60 * 1000);
  });

  it("creates a new user when the phone is unknown (created=true)", async () => {
    // SEC-10 fix: route uses a single updateMany that returns count=1 for
    // a valid unconsumed, non-expired code.
    mockOtpUpdateMany.mockResolvedValueOnce({ count: 1 });
    // First user lookup: not found
    mockUserFindUnique
      .mockResolvedValueOnce(null) // initial lookup by phone
      .mockResolvedValueOnce({    // after create, re-fetch with includes
        id: "user_new",
        phone: "+989111111111",
        phoneVerified: true,
        role: "CUSTOMER",
        name: "MEKANIX User 1111",
        customer: { id: "cust_new", userId: "user_new" },
        technician: null,
      });
    mockUserCreate.mockResolvedValueOnce({
      id: "user_new",
      phone: "+989111111111",
      phoneVerified: true,
      role: "CUSTOMER",
      name: "MEKANIX User 1111",
      customer: null,
      technician: null,
    });
    mockCustomerCreate.mockResolvedValueOnce({ id: "cust_new", userId: "user_new" });

    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989111111111",
      code: "999999",
      name: "New User",
    });
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.user.id).toBe("user_new");
  });

  it("returns 400 for an invalid code (no matching OTP record)", async () => {
    // SEC-10 fix: updateMany returns count=0 when no row matches the WHERE
    // clause (phone + code hash + consumed:false + not expired). This
    // covers the "invalid code" case (no row with that hash) AND the
    // "already consumed" case (no row with consumed:false) AND the
    // "expired" case (no row with expiresAt > now).
    mockOtpUpdateMany.mockResolvedValueOnce({ count: 0 });

    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989121234567",
      code: "000000",
    });
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    // No user lookup should have happened
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns 400 for an expired code", async () => {
    // SEC-10 fix: the atomic updateMany WHERE clause includes
    // `expiresAt: { gt: now }`. An expired code (expiresAt < now) does NOT
    // match the WHERE clause, so updateMany returns count=0 → 400.
    // (No need to mock a fake OTP row — the WHERE clause filters it out.)
    mockOtpUpdateMany.mockResolvedValueOnce({ count: 0 });

    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989121234567",
      code: "123456",
    });
    const res = await otpVerifyPOST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 400 when the code is not 6 digits (schema validation)", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989121234567",
      code: "12345", // too short
    });
    const res = await otpVerifyPOST(req);
    expect(res.status).toBe(400);
    expect(mockOtpUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when phone is missing", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      code: "123456",
    });
    const res = await otpVerifyPOST(req);
    expect(res.status).toBe(400);
    expect(mockOtpUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 400 when code is missing", async () => {
    const req = jsonReq("https://mekanix.test/api/auth/otp/verify", {
      phone: "+989121234567",
    });
    const res = await otpVerifyPOST(req);
    expect(res.status).toBe(400);
    expect(mockOtpUpdateMany).not.toHaveBeenCalled();
  });
});
