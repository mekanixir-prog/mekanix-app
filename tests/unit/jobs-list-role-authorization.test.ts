// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  customer: vi.fn(),
  technician: vi.fn(),
  db: vi.fn(),
  findMany: vi.fn(),
  wantsLite: vi.fn(),
  liteResponse: vi.fn(),
  maskJobFinancialData: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  getCustomerFromSession: mocks.customer,
  getTechnicianFromSession: mocks.technician,
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.db }));
vi.mock("@/lib/lite-response", () => ({
  wantsLite: mocks.wantsLite,
  liteResponse: mocks.liteResponse,
}));
vi.mock("@/lib/money/financial-read-mask", () => ({
  maskJobFinancialData: mocks.maskJobFinancialData,
}));

import { GET } from "@/app/api/jobs/route";

function request(status?: string) {
  const url = new URL("https://mekanix.test/api/jobs");
  if (status) url.searchParams.set("status", status);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.technician.mockResolvedValue({ id: "technician-1" });
  mocks.findMany.mockResolvedValue([]);
  mocks.db.mockResolvedValue({ job: { findMany: mocks.findMany } });
  mocks.wantsLite.mockReturnValue(false);
  mocks.liteResponse.mockImplementation((value) => value);
  mocks.maskJobFinancialData.mockImplementation((value) => value);
});

describe("GET /api/jobs role scoping", () => {
  it.each(["PARTNER", "FLEET_MANAGER"] as const)(
    "fails closed for %s because no job-list scope is defined",
    async (role) => {
      mocks.auth.mockResolvedValue({ userId: "unscoped-user", role });

      const response = await GET(request());

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "دسترسی به فهرست کارها مجاز نیست",
      });
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.findMany).not.toHaveBeenCalled();
    },
  );

  it("scopes customer jobs to the authenticated customer's requests", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });

    const response = await GET(request("REQUESTED"));

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "REQUESTED", request: { customerId: "customer-1" } },
    }));
  });

  it("scopes technician jobs to the authenticated technician profile", async () => {
    mocks.auth.mockResolvedValue({ userId: "technician-user", role: "TECHNICIAN" });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { technicianId: "technician-1" },
    }));
  });

  it("allows ADMIN to list jobs without an owner filter", async () => {
    const response = await GET(request("ACCEPTED"));

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ACCEPTED" },
    }));
  });
});
