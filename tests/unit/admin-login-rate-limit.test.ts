// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  ensureDefaultAdmin: vi.fn(),
  verifyPassword: vi.fn(),
  createAdminToken: vi.fn(),
  findAdmin: vi.fn(),
  updateAdmin: vi.fn(),
  audit: vi.fn(),
  clientId: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: mocks.rateLimit,
  getClientId: mocks.clientId,
}));
vi.mock("@/lib/admin-auth", () => ({
  ensureDefaultAdmin: mocks.ensureDefaultAdmin,
  verifyPassword: mocks.verifyPassword,
  createAdminToken: mocks.createAdminToken,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    adminUser: { findFirst: mocks.findAdmin, update: mocks.updateAdmin },
  }),
}));
vi.mock("@/lib/admin-api", () => ({ writeAuditLog: mocks.audit }));

import { POST } from "@/app/api/admin-panel/auth/login/route";

function request(body: unknown) {
  return new Request("https://mekanix.test/api/admin-panel/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientId.mockReturnValue("203.0.113.10");
  mocks.rateLimit.mockResolvedValue({ success: true, resetMs: 900_000 });
  mocks.ensureDefaultAdmin.mockResolvedValue(undefined);
  mocks.findAdmin.mockResolvedValue({
    id: "admin-1", username: "operator", email: "operator@mekanix.ir",
    passwordHash: "hash", name: "Operator", role: "SUPER_ADMIN",
  });
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.updateAdmin.mockResolvedValue({});
  mocks.createAdminToken.mockResolvedValue("signed-admin-token");
  mocks.audit.mockResolvedValue(undefined);
});

describe("admin login distributed rate limiting", () => {
  it("fails closed with 503 before touching the admin database when the IP bucket is unavailable", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ success: false, resetMs: 900_000, unavailable: true });
    const response = await POST(request({ emailOrUsername: "operator", password: "secret" }));
    expect(response.status).toBe(503);
    expect(mocks.ensureDefaultAdmin).not.toHaveBeenCalled();
    expect(mocks.findAdmin).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the account bucket is unavailable", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, resetMs: 900_000 })
      .mockResolvedValueOnce({ success: false, resetMs: 900_000, unavailable: true });
    const response = await POST(request({ emailOrUsername: "operator@mekanix.ir", password: "secret" }));
    expect(response.status).toBe(503);
    expect(mocks.ensureDefaultAdmin).not.toHaveBeenCalled();
    expect(mocks.findAdmin).not.toHaveBeenCalled();
  });

  it("applies both IP and hashed-account budgets before password verification", async () => {
    const response = await POST(request({ emailOrUsername: "operator@mekanix.ir", password: "secret" }));
    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    const accountBucket = mocks.rateLimit.mock.calls[1][0] as string;
    expect(accountBucket).toMatch(/^admin-login:account:[a-f0-9]{64}$/);
    expect(accountBucket).not.toContain("operator");
    expect(mocks.ensureDefaultAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPassword).toHaveBeenCalledWith("secret", "hash");
  });

  it("returns 429 when the account-specific bucket is exhausted", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, resetMs: 900_000 })
      .mockResolvedValueOnce({ success: false, resetMs: 30_000 });
    const response = await POST(request({ emailOrUsername: "operator", password: "secret" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.findAdmin).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads before bootstrap or credential lookup", async () => {
    const response = await POST(new Request("https://mekanix.test/api/admin-panel/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }));
    expect(response.status).toBe(400);
    expect(mocks.ensureDefaultAdmin).not.toHaveBeenCalled();
    expect(mocks.findAdmin).not.toHaveBeenCalled();
  });
});
