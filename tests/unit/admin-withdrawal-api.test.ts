// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  notify: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/admin-auth", () => ({ getAdminFromRequest: mocks.admin }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    withdrawalRequest: {
      findMany: mocks.list,
      findUnique: mocks.find,
    },
    notification: { create: mocks.notify },
  }),
}));
vi.mock("@/lib/withdrawal-admin-atomic", () => ({
  updateWithdrawalAtomically: mocks.update,
}));
vi.mock("@/lib/admin-api", () => ({ writeAuditLog: mocks.audit }));

import { GET } from "@/app/api/admin/[resource]/route";
import { PATCH } from "@/app/api/admin/[resource]/[id]/route";

const admin = { adminId: "admin-1", username: "operator", role: "ADMIN" };
const before = {
  id: "wd-1", walletId: "wallet-1", amount: 500, method: "bank", shebaNumber: "IR123456789012345678901234", status: "REQUESTED",
  wallet: { technician: { userId: "tech-user-1", user: { name: "Technician" } } },
};
const after = { ...before, status: "APPROVED" };

function request(body?: unknown) {
  return new Request("https://mekanix.test/api/admin/withdrawals/wd-1", {
    method: body === undefined ? "GET" : "PATCH",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue(admin);
  mocks.list.mockResolvedValue([before]);
  mocks.find.mockResolvedValueOnce(before).mockResolvedValue(after);
  mocks.update.mockResolvedValue(true);
  mocks.notify.mockResolvedValue({});
  mocks.audit.mockResolvedValue(undefined);
});

describe("admin withdrawal API", () => {
  it("lists withdrawal requests with technician identity", async () => {
    const response = await GET(request(), { params: Promise.resolve({ resource: "withdrawals" }) });
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("approves a request and writes audit/notification after the transition", async () => {
    const response = await PATCH(request({ status: "APPROVED" }), {
      params: Promise.resolve({ resource: "withdrawals", id: "wd-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      withdrawalId: "wd-1", action: "APPROVED", adminId: "admin-1",
    }));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown transitions before any financial write", async () => {
    const response = await PATCH(request({ status: "CANCELLED" }), {
      params: Promise.resolve({ resource: "withdrawals", id: "wd-1" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns conflict when another administrator already changed the state", async () => {
    mocks.update.mockResolvedValue(false);
    const response = await PATCH(request({ status: "PAID" }), {
      params: Promise.resolve({ resource: "withdrawals", id: "wd-1" }),
    });
    expect(response.status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
