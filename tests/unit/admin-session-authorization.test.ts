// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  findUser: vi.fn(),
  findAdmin: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    user: { findUnique: mocks.findUser },
    adminUser: { findUnique: mocks.findAdmin },
  }),
}));

import {
  ADMIN_SESSION_COOKIE,
  createAdminToken,
  getAdminFromRequest,
  verifyAdminToken,
} from "@/lib/admin-auth";

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ADMIN_JWT_SECRET", "test-admin-session-secret-with-at-least-32-bytes");
});

describe("admin session authorization", () => {
  it("accepts only an active database ADMIN account through the OTP AdminApp bearer path", async () => {
    mocks.verifySession.mockResolvedValue({ userId: "u1", role: "ADMIN" });
    mocks.findUser.mockResolvedValue({ name: "Admin", role: "ADMIN", status: "ACTIVE" });
    const req = new Request("https://mekanix.test", {
      headers: { authorization: "Bearer valid-otp-session" },
    });
    await expect(getAdminFromRequest(req)).resolves.toEqual({
      adminId: "u1",
      username: "Admin",
      role: "ADMIN",
    });
  });

  it("rejects a demoted or suspended OTP AdminApp account", async () => {
    mocks.verifySession.mockResolvedValue({ userId: "u1", role: "ADMIN" });
    mocks.findUser.mockResolvedValue({ name: "Admin", role: "CUSTOMER", status: "SUSPENDED" });
    const req = new Request("https://mekanix.test", {
      headers: { authorization: "Bearer valid-otp-session" },
    });
    await expect(getAdminFromRequest(req)).resolves.toBeNull();
  });

  it("accepts a dedicated admin cookie only when its persisted session version matches", async () => {
    const token = await createAdminToken({
      adminId: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 7,
    });
    mocks.findAdmin.mockResolvedValue({
      id: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 7,
    });

    const req = new Request("https://mekanix.test/api/admin-panel/auth/me", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    await expect(getAdminFromRequest(req)).resolves.toEqual({
      adminId: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 7,
    });
    expect(mocks.findAdmin).toHaveBeenCalledWith({
      where: { id: "a1" },
      select: { id: true, username: true, role: true, sessionVersion: true },
    });
  });

  it("rejects a revoked dedicated admin cookie after the server-side version changes", async () => {
    const token = await createAdminToken({
      adminId: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 7,
    });
    mocks.findAdmin.mockResolvedValue({
      id: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 8,
    });

    const req = new Request("https://mekanix.test/api/admin-panel/auth/me", {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    await expect(getAdminFromRequest(req)).resolves.toBeNull();
  });

  it("does not accept dedicated admin JWTs through the browser-readable bearer path", async () => {
    const token = await createAdminToken({
      adminId: "a1",
      username: "operator",
      role: "SUPER_ADMIN",
      sessionVersion: 0,
    });
    mocks.verifySession.mockResolvedValue(null);
    const req = new Request("https://mekanix.test/api/admin-panel/onboarding", {
      headers: { authorization: `Bearer ${token}` },
    });
    await expect(getAdminFromRequest(req)).resolves.toBeNull();
  });

  it("requires a dedicated ADMIN_JWT_SECRET for dedicated admin tokens in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("JWT_SECRET", "shared-user-session-secret");
    vi.stubEnv("ADMIN_JWT_SECRET", "");
    await expect(createAdminToken({ adminId: "a1", username: "operator", role: "ADMIN" }))
      .rejects.toThrow("ADMIN_JWT_SECRET");
    await expect(verifyAdminToken("not-a-token")).resolves.toBeNull();
  });

  it("rejects a weak dedicated admin secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_JWT_SECRET", "short-secret");
    await expect(createAdminToken({ adminId: "a1", username: "operator", role: "ADMIN" }))
      .rejects.toThrow("at least 32 bytes");
  });

  it("signs and verifies dedicated admin tokens with the isolated production secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_JWT_SECRET", "dedicated-admin-secret-with-sufficient-entropy");
    vi.stubEnv("JWT_SECRET", "different-user-session-secret");
    const session = { adminId: "a1", username: "operator", role: "ADMIN", sessionVersion: 2 };
    const token = await createAdminToken(session);
    await expect(verifyAdminToken(token)).resolves.toEqual(session);
  });
});
