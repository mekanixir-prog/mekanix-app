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
// (SEC-5 tests for rate limit + audit log are appended in a separate describe
//  block — see "SEC-5 — admin login rate limit + audit log" below.)
//
// The mocks below (rateLimitAsync, writeAuditLog) are set up here so the file
// is forward-compatible: when SEC-5 changes are added to the route, the
// SEC-13 tests continue to pass without modification.
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
    // Forward-compat: SEC-5 will use rateLimit + auditLog tables. Provide
    // no-op mocks so writeAuditLog / rateLimitAsync fail-open silently
    // (they catch errors internally) when the SEC-5 changes are added.
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

// Forward-compat mocks — used by SEC-5 tests below. Defined here so the
// module-level mock setup is stable across both describe blocks.
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
  // Default: rate limit allows (SEC-5 forward-compat)
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
