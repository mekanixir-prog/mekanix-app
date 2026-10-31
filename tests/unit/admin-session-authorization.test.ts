import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verifySession: vi.fn(), findUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/db-access", () => ({ getDbForLib: async () => ({ user: { findUnique: mocks.findUser } }) }));
import { createAdminToken, getAdminFromRequest, verifyAdminToken } from "@/lib/admin-auth";
afterEach(() => vi.unstubAllEnvs());
describe("admin session authorization", () => {
  it("accepts only an active database ADMIN account", async () => {
    mocks.verifySession.mockResolvedValue({ userId: "u1", role: "ADMIN" });
    mocks.findUser.mockResolvedValue({ name: "Admin", role: "ADMIN", status: "ACTIVE" });
    const req = new Request("https://mekanix.test", { headers: { authorization: "Bearer invalid-user-token" } });
    await expect(getAdminFromRequest(req)).resolves.toEqual({ adminId: "u1", username: "Admin", role: "ADMIN" });
  });
  it("rejects a demoted or suspended account", async () => {
    mocks.verifySession.mockResolvedValue({ userId: "u1", role: "ADMIN" });
    mocks.findUser.mockResolvedValue({ name: "Admin", role: "CUSTOMER", status: "SUSPENDED" });
    const req = new Request("https://mekanix.test", { headers: { authorization: "Bearer invalid-user-token" } });
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

  it("signs and verifies dedicated admin tokens with the isolated production secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_JWT_SECRET", "dedicated-admin-secret-with-sufficient-entropy");
    vi.stubEnv("JWT_SECRET", "different-user-session-secret");
    const session = { adminId: "a1", username: "operator", role: "ADMIN" };
    const token = await createAdminToken(session);
    await expect(verifyAdminToken(token)).resolves.toEqual(session);
  });
});
