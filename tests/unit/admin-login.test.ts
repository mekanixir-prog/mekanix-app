// @vitest-environment node
// MEKANIX — SEC-13 + SEC-5 Admin Login Tests (Bundle 3)
// ============================================================================
// Verifies the SEC-13 fix in src/app/api/admin-panel/auth/login/route.ts:
//   1. Non-existent user → 401 with unified message
//   2. Wrong password → 401 with SAME unified message
//   3. Both cases return identical status (401) + message
//   4. verifyPassword is always called (even when admin not found) — timing
//   5. Valid credentials → 200 + token
//
// Verifies the SEC-5 fix (rate limit + audit log):
//   6. After 5 failed attempts, returns 429
//   7. Failed login creates audit log entry (FAILED_ADMIN_LOGIN)
//   8. Successful login creates audit log entry (ADMIN_LOGIN_SUCCESS)
//   9. Audit log failure does NOT block the login (best-effort audit)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockAdminUserFindFirst = vi.fn();
const mockAdminUserUpdate = vi.fn();
const mockAdminUserCount = vi.fn();
const mockAdminUserCreate = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    adminUser: {
      findFirst: (...args: any[]) => mockAdminUserFindFirst(...args),
      update: (...args: any[]) => mockAdminUserUpdate(...args),
      count: (...args: any[]) => mockAdminUserCount(...args),
      create: (...args: any[]) => mockAdminUserCreate(...args),
    },
    // SEC-5: rateLimit + auditLog tables. writeAuditLog / rateLimitAsync
    // fail-open silently (they catch errors internally) when the mocks below
    // don't return what they need, but providing them keeps the test clean.
    rateLimit: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  })),
}));

// Mock admin-auth — controllable per-test
const mockVerifyPassword = vi.fn();
const mockCreateAdminToken = vi.fn();
const mockEnsureDefaultAdmin = vi.fn();
vi.mock("@/lib/admin-auth", () => ({
  verifyPassword: (...args: any[]) => mockVerifyPassword(...args),
  createAdminToken: (...args: any[]) => mockCreateAdminToken(...args),
  ensureDefaultAdmin: (...args: any[]) => mockEnsureDefaultAdmin(...args),
  hashPassword: vi.fn().mockResolvedValue("$2b$12$hashed"),
}));

// SEC-5 mocks — rate limit + audit log
const mockRateLimitAsync = vi.fn();
const mockGetClientId = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: (...args: any[]) => mockRateLimitAsync(...args),
  getClientId: (...args: any[]) => mockGetClientId(...args),
  rateLimit: vi.fn(),
  RATE_LIMITS: { API_DEFAULT: { max: 60, windowMs: 60_000 } },
}));

const mockWriteAuditLog = vi.fn();
vi.mock("@/lib/admin-api", () => ({
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
  getPagination: vi.fn(),
  getQuery: vi.fn(),
  daysAgo: vi.fn(),
}));

// ──────────── Import route handler (after mocks hoisted) ────────────
import { POST } from "@/app/api/admin-panel/auth/login/route";

// ──────────── Helpers ────────────
function makeLoginRequest(emailOrUsername: string, password: string): Request {
  return new Request("http://localhost/api/admin-panel/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "1.2.3.4",
    },
    body: JSON.stringify({ emailOrUsername, password }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureDefaultAdmin.mockResolvedValue(undefined);
  mockGetClientId.mockReturnValue("1.2.3.4");
  // Default: rate limit allows (SEC-5)
  mockRateLimitAsync.mockResolvedValue({ success: true, resetMs: 15 * 60_000 });
  // Default: verifyPassword returns true (valid)
  mockVerifyPassword.mockResolvedValue(true);
  mockCreateAdminToken.mockResolvedValue("mock-jwt-token");
  mockAdminUserUpdate.mockResolvedValue({});
  mockAdminUserCount.mockResolvedValue(1); // ensureDefaultAdmin skips creation
  mockWriteAuditLog.mockResolvedValue(undefined);
});

// ──────────── SEC-13: User Enumeration Mitigation ────────────
describe("SEC-13 — admin login user enumeration mitigation", () => {
  const UNAUTH_MSG = "ایمیل/یوزرنیم یا پسورد اشتباه است";

  it("returns 401 with unified message for non-existent user", async () => {
    mockAdminUserFindFirst.mockResolvedValue(null);
    // verifyPassword is called even when admin is null (against DUMMY_HASH)
    mockVerifyPassword.mockResolvedValue(false);

    const req = makeLoginRequest("nonexistent@example.com", "anypassword");
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(UNAUTH_MSG);
  });

  it("returns 401 with SAME unified message for wrong password", async () => {
    mockAdminUserFindFirst.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValue(false); // wrong password

    const req = makeLoginRequest("admin@mekanix.ir", "wrongpassword");
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(UNAUTH_MSG);
  });

  it("both cases (user-not-found + wrong-password) return identical status + message", async () => {
    // Case 1: user not found
    mockAdminUserFindFirst.mockResolvedValueOnce(null);
    mockVerifyPassword.mockResolvedValueOnce(false);
    const res1 = await POST(makeLoginRequest("nobody@example.com", "x"));
    const body1 = await res1.json();

    // Case 2: wrong password (admin exists)
    mockAdminUserFindFirst.mockResolvedValueOnce({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValueOnce(false);
    const res2 = await POST(makeLoginRequest("admin@mekanix.ir", "x"));
    const body2 = await res2.json();

    // Both must be identical (status + error message)
    expect(res1.status).toBe(res2.status);
    expect(body1.error).toBe(body2.error);
    expect(res1.status).toBe(401);
    expect(body1.error).toBe(UNAUTH_MSG);
  });

  it("verifyPassword is ALWAYS called, even when admin is not found (timing mitigation)", async () => {
    mockAdminUserFindFirst.mockResolvedValue(null);
    mockVerifyPassword.mockResolvedValue(false);

    const req = makeLoginRequest("nonexistent@example.com", "anypassword");
    await POST(req);

    // CRITICAL: verifyPassword MUST be called even when admin is null.
    // Without this, response timing would reveal whether the user exists
    // (no bcrypt comparison = much faster response when user doesn't exist).
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it("returns 200 + token for valid credentials", async () => {
    mockAdminUserFindFirst.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin User",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateAdminToken.mockResolvedValue("jwt-token-123");

    const req = makeLoginRequest("admin", "admin12345");
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("jwt-token-123");
    expect(body.admin.id).toBe("admin-1");
    expect(body.admin.username).toBe("admin");
  });

  it("returns 400 when emailOrUsername or password is missing", async () => {
    const req = makeLoginRequest("", "");
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ──────────── SEC-5: Rate Limit + Audit Log ────────────
describe("SEC-5 — admin login rate limit + audit log", () => {
  it("returns 429 when rate limit is exceeded (after 5 failed attempts)", async () => {
    // Simulate the 6th attempt — rate limit returns success: false.
    mockRateLimitAsync.mockResolvedValueOnce({ success: false, resetMs: 15 * 60_000 });

    const req = makeLoginRequest("admin@mekanix.ir", "wrong");
    const res = await POST(req);
    expect(res.status).toBe(429);
    // Retry-After header should be present (in seconds)
    expect(res.headers.get("retry-after")).toBeTruthy();
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);

    // CRITICAL: when rate-limited, the route must NOT call verifyPassword
    // (don't leak timing info about whether the user exists) and must NOT
    // call writeAuditLog for the login attempt (the rate-limit event itself
    // is the audit signal — no need to spam FAILED_ADMIN_LOGIN on every
    // rate-limited request).
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockWriteAuditLog).not.toHaveBeenCalled();
  });

  it("rate limit uses a per-IP key derived from getClientId(req)", async () => {
    mockGetClientId.mockReturnValueOnce("203.0.113.99");
    mockAdminUserFindFirst.mockResolvedValue(null);
    mockVerifyPassword.mockResolvedValue(false);

    await POST(makeLoginRequest("nobody@example.com", "x"));

    // rateLimitAsync was called with the IP-scoped key
    expect(mockRateLimitAsync).toHaveBeenCalledTimes(2);
    const ipArgs = mockRateLimitAsync.mock.calls[0];
    expect(ipArgs[0]).toBe("admin-login:ip:203.0.113.99");
    expect(ipArgs[1]).toBe(5); // max attempts
    expect(ipArgs[2]).toBe(15 * 60_000); // 15 min window
    const accountKey = mockRateLimitAsync.mock.calls[1][0] as string;
    expect(accountKey).toMatch(/^admin-login:account:[a-f0-9]{64}$/);
    expect(accountKey).not.toContain("nobody@example.com");
  });

  it("failed login (wrong password) creates audit log entry with action FAILED_ADMIN_LOGIN", async () => {
    mockAdminUserFindFirst.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValue(false); // wrong password

    const req = makeLoginRequest("admin@mekanix.ir", "wrongpassword");
    await POST(req);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const args = mockWriteAuditLog.mock.calls[0][0];
    expect(args.action).toBe("FAILED_ADMIN_LOGIN");
    expect(args.entity).toBe("AdminUser");
    expect(args.entityId).toBe("admin-1");
    expect(args.session.adminId).toBe("admin-1");
    expect(args.after.reason).toBe("wrong_password");
  });

  it("failed login for non-existent user creates audit log with adminId 'unknown'", async () => {
    mockAdminUserFindFirst.mockResolvedValue(null);
    mockVerifyPassword.mockResolvedValue(false);

    const req = makeLoginRequest("nobody@example.com", "wrong");
    await POST(req);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const args = mockWriteAuditLog.mock.calls[0][0];
    expect(args.action).toBe("FAILED_ADMIN_LOGIN");
    expect(args.session.adminId).toBe("unknown");
    expect(args.after.reason).toBe("user_not_found");
  });

  it("successful login creates audit log entry with action ADMIN_LOGIN_SUCCESS", async () => {
    mockAdminUserFindFirst.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateAdminToken.mockResolvedValue("jwt-123");

    const req = makeLoginRequest("admin", "admin12345");
    await POST(req);

    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const args = mockWriteAuditLog.mock.calls[0][0];
    expect(args.action).toBe("ADMIN_LOGIN_SUCCESS");
    expect(args.entity).toBe("AdminUser");
    expect(args.entityId).toBe("admin-1");
    expect(args.session.adminId).toBe("admin-1");
  });

  it("audit log failure does NOT block the login (best-effort audit)", async () => {
    // writeAuditLog rejects — but the login should still succeed
    mockWriteAuditLog.mockRejectedValue(new Error("audit log service down"));
    mockAdminUserFindFirst.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: "admin@mekanix.ir",
      passwordHash: "$2b$12$realhash",
      name: "Admin User",
      role: "SUPER_ADMIN",
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateAdminToken.mockResolvedValue("jwt-123");

    const req = makeLoginRequest("admin", "admin12345");
    const res = await POST(req);

    // CRITICAL: login succeeds even though audit log failed
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("jwt-123");
    // writeAuditLog was attempted (even though it failed)
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });

  it("fails closed with 503 when the shared rate-limit store is unavailable", async () => {
    mockRateLimitAsync.mockResolvedValueOnce({
      success: false,
      resetMs: 15 * 60_000,
      unavailable: true,
    });

    const req = makeLoginRequest("admin", "admin12345");
    const res = await POST(req);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("900");
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockAdminUserFindFirst).not.toHaveBeenCalled();
  });
});
