// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  getDb: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentFindUnique: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.admin,
  hasValidAdminCookieCsrf: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: mocks.getDb,
}));
vi.mock("@/lib/admin-api", () => ({
  writeAuditLog: vi.fn(),
}));

import { PATCH } from "@/app/api/admin/[resource]/[id]/route";

describe("admin payment status guard", () => {
  it("rejects generic payment status mutations before touching the database", async () => {
    mocks.admin.mockResolvedValue({
      adminId: "admin-1",
      username: "admin",
      role: "SUPER_ADMIN",
    });
    mocks.paymentUpdate.mockClear();
    mocks.paymentFindUnique.mockClear();
    mocks.getDb.mockResolvedValue({
      payment: {
        update: mocks.paymentUpdate,
        findUnique: mocks.paymentFindUnique,
      },
    });

    const req = new Request("https://mekanix.test/api/admin/payments/pay-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "REFUNDED" }),
    });
    const response = await PATCH(req, {
      params: Promise.resolve({ resource: "payments", id: "pay-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.code).toBe("PAYMENT_STATUS_REQUIRES_RECONCILIATION");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentFindUnique).not.toHaveBeenCalled();
  });
});
