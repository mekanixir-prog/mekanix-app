// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAdmin: vi.fn(),
  updateMany: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    adminUser: {
      findUnique: mocks.findAdmin,
      updateMany: mocks.updateMany,
    },
  }),
}));
vi.mock("@/lib/admin-api", () => ({ writeAuditLog: mocks.audit }));

import { POST } from "@/app/api/admin-panel/auth/logout/route";
import { ADMIN_SESSION_COOKIE, createAdminToken, hasValidAdminCookieCsrf, isSameOriginRequest, setAdminSessionCookie } from "@/lib/admin-auth";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ADMIN_JWT_SECRET", "test-admin-session-secret-with-at-least-32-bytes");
  mocks.findAdmin.mockResolvedValue({
    id: "admin-1",
    username: "operator",
    role: "SUPER_ADMIN",
    sessionVersion: 4,
  });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("admin cookie logout and CSRF protection", () => {
  it("sets the real production cookie attributes without exposing the token to JavaScript", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = new Response(null);
    const req = new Request("http://mekanix.test/api/admin-panel/auth/login");
    setAdminSessionCookie(response, "signed.jwt.value", req);
    const cookie = response.headers.get("set-cookie") || "";

    expect(cookie).toContain("mekanix_admin_session=signed.jwt.value");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/admin-panel");
    expect(cookie).toContain("Max-Age=604800");
  });

  it("requires an exact same-origin signal and rejects cross-origin or same-site sibling requests", () => {
    expect(isSameOriginRequest(new Request("https://mekanix.test/api/admin-panel", {
      headers: { origin: "https://mekanix.test", "sec-fetch-site": "same-origin" },
    }))).toBe(true);
    expect(isSameOriginRequest(new Request("https://mekanix.test/api/admin-panel", {
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    }))).toBe(false);
    expect(isSameOriginRequest(new Request("https://mekanix.test/api/admin-panel", {
      headers: { origin: "https://sub.mekanix.test", "sec-fetch-site": "same-site" },
    }))).toBe(false);
  });


  it("requires same-origin validation only when the dedicated admin cookie is present", () => {
    const bearerOnly = new Request("https://mekanix.test/api/admin/withdrawals/wd-1", {
      headers: { authorization: "Bearer user-session-token" },
    });
    expect(hasValidAdminCookieCsrf(bearerOnly)).toBe(true);

    const sameOriginCookie = new Request("https://mekanix.test/api/admin/withdrawals/wd-1", {
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=signed.jwt.value`,
        origin: "https://mekanix.test",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(hasValidAdminCookieCsrf(sameOriginCookie)).toBe(true);

    const crossOriginCookie = new Request("https://mekanix.test/api/admin/withdrawals/wd-1", {
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=signed.jwt.value`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(hasValidAdminCookieCsrf(crossOriginCookie)).toBe(false);

    const missingOriginSignal = new Request("https://mekanix.test/api/admin/withdrawals/wd-1", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=signed.jwt.value` },
    });
    expect(hasValidAdminCookieCsrf(missingOriginSignal)).toBe(false);
  });

  it("revokes the persisted session version and clears the HttpOnly cookie", async () => {
    const token = await createAdminToken({
      adminId: "admin-1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 4,
    });
    const req = new Request("https://mekanix.test/api/admin-panel/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        origin: "https://mekanix.test",
        "sec-fetch-site": "same-origin",
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "admin-1", sessionVersion: 4 },
      data: { sessionVersion: { increment: 1 } },
    });
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("mekanix_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api/admin-panel");
    expect(setCookie).toContain("Max-Age=0");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ADMIN_LOGOUT",
      entityId: "admin-1",
    }));
  });

  it("rejects a cross-origin logout without revoking the session", async () => {
    const token = await createAdminToken({
      adminId: "admin-1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 4,
    });
    const req = new Request("https://mekanix.test/api/admin-panel/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(403);
    expect(mocks.findAdmin).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("clears a stale cookie even when its server-side session is already revoked", async () => {
    const token = await createAdminToken({
      adminId: "admin-1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 3,
    });
    mocks.findAdmin.mockResolvedValue({
      id: "admin-1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 4,
    });
    const req = new Request("https://mekanix.test/api/admin-panel/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        origin: "https://mekanix.test",
      },
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
