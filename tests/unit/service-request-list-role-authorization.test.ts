// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  customer: vi.fn(),
  technician: vi.fn(),
  db: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  getCustomerFromSession: mocks.customer,
  getTechnicianFromSession: mocks.technician,
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.db }));

import { GET } from "@/app/api/service-requests/route";

function request(status?: string) {
  const url = new URL("https://mekanix.test/api/service-requests");
  if (status) url.searchParams.set("status", status);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.technician.mockResolvedValue({ id: "technician-1" });
  mocks.findMany.mockResolvedValue([]);
  mocks.db.mockResolvedValue({ serviceRequest: { findMany: mocks.findMany } });
});

// Regression coverage for the fail-closed role guard in the collection endpoint.
describe("GET /api/service-requests role scoping", () => {
  it.each(["PARTNER", "FLEET_MANAGER"] as const)(
    "fails closed for %s because no request-list scope is defined",
    async (role) => {
      mocks.auth.mockResolvedValue({ userId: "unscoped-user", role });

      const response = await GET(request());

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "دسترسی به فهرست درخواست‌ها مجاز نیست",
      });
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.findMany).not.toHaveBeenCalled();
    },
  );

  it("scopes customer results to the authenticated customer's profile", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });

    const response = await GET(request("OPEN"));

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "OPEN", customerId: "customer-1" },
    }));
  });

  it("scopes technician results to the authenticated technician profile", async () => {
    mocks.auth.mockResolvedValue({ userId: "technician-user", role: "TECHNICIAN" });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { matchedTechId: "technician-1" },
    }));
  });

  it("allows ADMIN to list requests without an owner filter", async () => {
    const response = await GET(request("ASSIGNED"));

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ASSIGNED" },
    }));
  });

  it("denies a customer whose profile is missing before querying requests", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
    mocks.customer.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("denies a technician whose profile is missing before querying requests", async () => {
    mocks.auth.mockResolvedValue({ userId: "technician-user", role: "TECHNICIAN" });
    mocks.technician.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
