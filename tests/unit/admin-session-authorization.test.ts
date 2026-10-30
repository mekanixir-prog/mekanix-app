import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verifySession: vi.fn(), findUser: vi.fn() }));
vi.mock("@/lib/auth", () => ({ verifySession: mocks.verifySession }));
vi.mock("@/lib/db-access", () => ({ getDbForLib: async () => ({ user: { findUnique: mocks.findUser } }) }));
import { getAdminFromRequest } from "@/lib/admin-auth";
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
});
