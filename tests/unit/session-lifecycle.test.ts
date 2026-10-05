// @vitest-environment node
// MEKANIX — FIX-2-SESSION-LIFECYCLE unit tests
//
// Verifies the Session DB lifecycle wiring added to `src/lib/auth.ts`:
//   - createSession writes a Session row (tokenHash is SHA-256 hex, NEVER the raw JWT)
//   - verifySession honours the DB record (revoked / expired / missing → null)
//   - verifySession falls back to JWT-only auth if the DB throws (backward compat)
//   - revokeSession marks `revokedAt = now` and is idempotent
//   - revokeAllUserSessions scopes by userId and is idempotent
//   - logout endpoint returns 200, calls revokeSession, clears the cookie
//   - logout endpoint returns 401 without auth
//
// We use the `node` environment (not jsdom) because we mint real JWTs via
// jose's `SignJWT`. See `tests/integration/auth.test.ts` for the rationale.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────── Mocks (hoisted) ────────────
const mockSessionCreate = vi.fn().mockResolvedValue({});
const mockSessionFindUnique = vi.fn();
const mockSessionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@/lib/db", () => ({
  db: {
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

// ──────────── Imports (after mocks hoisted) ────────────
import {
  createSession,
  verifySession,
  revokeSession,
  revokeAllUserSessions,
  type Session,
} from "@/lib/auth";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";

// ──────────── Helpers ────────────
const PAYLOAD: Session = {
  userId: "user_abc",
  role: "CUSTOMER",
  phone: "+989121234567",
  isGuest: false,
};

function validSessionRecord(overrides: Partial<{
  revokedAt: Date | null;
  expiresAt: Date;
}> = {}) {
  return {
    id: "sess_1",
    userId: "user_abc",
    tokenHash: "hash-placeholder",
    device: null,
    ip: null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
    revokedAt: overrides.revokedAt ?? null,
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionCreate.mockResolvedValue({});
  mockSessionUpdateMany.mockResolvedValue({ count: 0 });
  // Default: findUnique returns nothing — individual tests override
  mockSessionFindUnique.mockResolvedValue(null);
  // Silence the expected console.error logs from the backward-compat
  // try/catch paths we exercise below. We assert behaviour by return
  // value, not by log output.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ──────────── createSession ────────────
describe("createSession — DB record creation", () => {
  it("returns a string JWT (signing still works)", async () => {
    const token = await createSession(PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // header.payload.signature
  });

  it("writes a Session DB row with userId + tokenHash + expiresAt", async () => {
    const token = await createSession(PAYLOAD);
    expect(mockSessionCreate).toHaveBeenCalledTimes(1);
    const args = mockSessionCreate.mock.calls[0][0];
    expect(args.data.userId).toBe("user_abc");
    expect(args.data.tokenHash).toBeTypeOf("string");
    expect(args.data.expiresAt).toBeInstanceOf(Date);
  });

  it("stores a SHA-256 hex digest of the token — NEVER the raw JWT", async () => {
    const token = await createSession(PAYLOAD);
    const args = mockSessionCreate.mock.calls[0][0];
    // SHA-256 hex digest = 64 lowercase hex chars
    expect(args.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // The hash must NOT contain the JWT (which has dots and base64 chars)
    expect(args.data.tokenHash).not.toContain(".");
    expect(args.data.tokenHash).not.toEqual(token);
  });

  it("extracts device + ip from the request when provided", async () => {
    const req = new Request("https://mekanix.test/api/auth/otp/verify", {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (Test Browser)",
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      },
    });
    await createSession(PAYLOAD, req);
    const args = mockSessionCreate.mock.calls[0][0];
    expect(args.data.device).toBe("Mozilla/5.0 (Test Browser)");
    // X-Forwarded-For: first hop only, trimmed
    expect(args.data.ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const req = new Request("https://mekanix.test", {
      headers: { "x-real-ip": "198.51.100.42" },
    });
    await createSession(PAYLOAD, req);
    expect(mockSessionCreate.mock.calls[0][0].data.ip).toBe("198.51.100.42");
  });

  it("sets expiresAt to ~30 days from now (matching JWT exp)", async () => {
    const before = Date.now();
    await createSession(PAYLOAD);
    const after = Date.now();
    const expiresAt = mockSessionCreate.mock.calls[0][0].data.expiresAt.getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyDaysMs + 1000);
  });

  it("still returns the JWT even if the DB create throws (backward compat)", async () => {
    mockSessionCreate.mockRejectedValueOnce(new Error("Table missing"));
    const token = await createSession(PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  it("omits device/ip when no request is passed", async () => {
    await createSession(PAYLOAD); // no req
    const args = mockSessionCreate.mock.calls[0][0];
    expect(args.data.device).toBeNull();
    expect(args.data.ip).toBeNull();
  });
});

// ──────────── verifySession ────────────
describe("verifySession — DB revocation checks", () => {
  it("returns the session payload when the DB record is valid", async () => {
    const token = await createSession(PAYLOAD);
    // findUnique returns the same record (matching tokenHash)
    mockSessionFindUnique.mockResolvedValueOnce(validSessionRecord());

    const result = await verifySession(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user_abc");
    expect(result?.role).toBe("CUSTOMER");
    expect(result?.isGuest).toBe(false);
  });

  it("returns null when the DB record is missing (was revoked/cleared)", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(null); // not found

    const result = await verifySession(token);
    expect(result).toBeNull();
  });

  it("returns null when revokedAt is set (explicitly revoked)", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(
      validSessionRecord({ revokedAt: new Date() })
    );

    const result = await verifySession(token);
    expect(result).toBeNull();
  });

  it("returns null when the DB record is expired (expiresAt < now)", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(
      validSessionRecord({ expiresAt: new Date(Date.now() - 60_000) }) // 1 min ago
    );

    const result = await verifySession(token);
    expect(result).toBeNull();
  });

  it("returns null for an invalid JWT (regardless of DB state)", async () => {
    const result = await verifySession("not-a-jwt");
    expect(result).toBeNull();
    // Should not have queried the DB — JWT verification failed first
    expect(mockSessionFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to JWT-only auth when the DB throws (backward compat)", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockRejectedValueOnce(new Error("Session table missing"));

    const result = await verifySession(token);
    // Backward compat: DB error → fall back to JWT auth → return session
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user_abc");
  });

  it("queries by tokenHash matching the SHA-256 hash of the token", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(validSessionRecord());

    await verifySession(token);
    const queryArgs = mockSessionFindUnique.mock.calls[0][0];
    expect(queryArgs.where.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(queryArgs.where.tokenHash).not.toContain(".");
  });
});

// ──────────── revokeSession ────────────
describe("revokeSession — single-token revocation", () => {
  it("calls updateMany with the hashed token and revokedAt = now", async () => {
    await revokeSession("some.jwt.token");
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
    const args = mockSessionUpdateMany.mock.calls[0][0];
    expect(args.where.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(args.where.revokedAt).toBeNull(); // only un-revoked sessions
    expect(args.data.revokedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — calling twice on the same token is a no-op the second time", async () => {
    // First call: 1 row updated
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 1 });
    await revokeSession("some.jwt.token");
    // Second call: 0 rows (already revoked — the `revokedAt: null` filter excludes it)
    mockSessionUpdateMany.mockResolvedValueOnce({ count: 0 });
    await revokeSession("some.jwt.token");
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(2);
    // Both calls had the same where clause (revokedAt: null)
    expect(mockSessionUpdateMany.mock.calls[0][0].where.revokedAt).toBeNull();
    expect(mockSessionUpdateMany.mock.calls[1][0].where.revokedAt).toBeNull();
  });

  it("does NOT throw if the DB throws (graceful failure)", async () => {
    mockSessionUpdateMany.mockRejectedValueOnce(new Error("DB down"));
    await expect(revokeSession("some.jwt.token")).resolves.toBeUndefined();
  });
});

// ──────────── revokeAllUserSessions ────────────
describe("revokeAllUserSessions — user-wide revocation", () => {
  it("calls updateMany scoped by userId with revokedAt = now", async () => {
    await revokeAllUserSessions("user_abc");
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
    const args = mockSessionUpdateMany.mock.calls[0][0];
    expect(args.where.userId).toBe("user_abc");
    expect(args.where.revokedAt).toBeNull();
    expect(args.data.revokedAt).toBeInstanceOf(Date);
  });

  it("does NOT throw if the DB throws (graceful failure)", async () => {
    mockSessionUpdateMany.mockRejectedValueOnce(new Error("DB down"));
    await expect(revokeAllUserSessions("user_abc")).resolves.toBeUndefined();
  });

  it("does not touch already-revoked sessions (idempotent)", async () => {
    await revokeAllUserSessions("user_abc");
    expect(mockSessionUpdateMany.mock.calls[0][0].where.revokedAt).toBeNull();
  });
});

// ──────────── POST /api/auth/logout ────────────
describe("POST /api/auth/logout — endpoint", () => {
  it("returns 401 without authentication", async () => {
    const req = new Request("https://mekanix.test/api/auth/logout", {
      method: "POST",
    });
    const res = await logoutPOST(req);
    expect(res.status).toBe(401);
    // Should not have called revokeSession path
    expect(mockSessionUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 200 + revokes the session + clears the cookie", async () => {
    // Mint a real JWT, then mock the DB record so verifySession passes
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(validSessionRecord());

    const req = new Request("https://mekanix.test/api/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await logoutPOST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Should have revoked the session by tokenHash
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
    const updateArgs = mockSessionUpdateMany.mock.calls[0][0];
    expect(updateArgs.where.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(updateArgs.data.revokedAt).toBeInstanceOf(Date);

    // Should have cleared the cookie
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("mekanix-token=");
    expect(setCookie?.toLowerCase()).toMatch(/expires|max-age.*0/);
  });

  it("works with cookie-based auth too (not just Bearer)", async () => {
    const token = await createSession(PAYLOAD);
    mockSessionFindUnique.mockResolvedValueOnce(validSessionRecord());

    const req = new Request("https://mekanix.test/api/auth/logout", {
      method: "POST",
      headers: { cookie: `mekanix-token=${token}` },
    });
    const res = await logoutPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionUpdateMany).toHaveBeenCalledTimes(1);
  });
});
