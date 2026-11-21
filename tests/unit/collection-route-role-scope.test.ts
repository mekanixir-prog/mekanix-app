// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  customer: vi.fn(),
  technician: vi.fn(),
  jobs: vi.fn(),
  requests: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    customer: { findUnique: mocks.customer },
    technician: { findUnique: mocks.technician },
    job: { findMany: mocks.jobs },
    serviceRequest: { findMany: mocks.requests },
  })),
}));
vi.mock("@/lib/auth", () => ({
  getCustomerFromSession: vi.fn(async () => ({ id: "customer-1" })),
  getTechnicianFromSession: vi.fn(async () => ({ id: "technician-1" })),
}));
vi.mock("@/lib/lite-response", () => ({
  wantsLite: vi.fn(() => false),
  liteResponse: vi.fn((value) => value),
}));
vi.mock("@/lib/money/financial-read-mask", () => ({
  maskJobFinancialData: vi.fn((value) => value),
  maskFinancialFields: vi.fn((value) => value),
}));
vi.mock("@/lib/idempotency", () => ({
  IdempotencyConflictError: class extends Error {},
  readIdempotencyKey: vi.fn(() => "test-key"),
  requestFingerprint: vi.fn(async () => "fingerprint"),
}));
vi.mock("@/lib/service-request-atomic", () => ({
  createServiceRequestAtomically: vi.fn(),
  ServiceRequestVehicleError: class extends Error {},
}));
vi.mock("@/lib/vehicle-scope", () => ({ isVehicleInSupportedScope: vi.fn(() => true) }));

import { GET as getJobs } from "@/app/api/jobs/route";
import { GET as getServiceRequests } from "@/app/api/service-requests/route";

const request = () => new Request("https://mekanix.test/api/list");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "user-1", role: "CUSTOMER" });
  mocks.jobs.mockResolvedValue([]);
  mocks.requests.mockResolvedValue([]);
});

describe("collection route authorization scopes", () => {
  it.each(["FLEET_MANAGER", "PARTNER", "UNKNOWN"])(
    "denies unscoped role %s from both jobs and service-request collections",
    async (role) => {
      mocks.requireAuth.mockResolvedValue({ userId: "user-1", role });
      const jobsResponse = await getJobs(request());
      const requestsResponse = await getServiceRequests(request());
      expect(jobsResponse.status).toBe(403);
      expect(requestsResponse.status).toBe(403);
      expect(mocks.jobs).not.toHaveBeenCalled();
      expect(mocks.requests).not.toHaveBeenCalled();
    },
  );

  it("scopes customer job and service-request lists to the session customer", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
    await getJobs(request());
    await getServiceRequests(request());
    expect(mocks.jobs).toHaveBeenCalledWith(expect.objectContaining({
      where: { request: { customerId: "customer-1" } },
    }));
    expect(mocks.requests).toHaveBeenCalledWith(expect.objectContaining({
      where: { customerId: "customer-1" },
    }));
  });

  it("scopes technician lists to the technician profile linked to the session", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
    await getJobs(request());
    await getServiceRequests(request());
    expect(mocks.jobs).toHaveBeenCalledWith(expect.objectContaining({
      where: { technicianId: "technician-1" },
    }));
    expect(mocks.requests).toHaveBeenCalledWith(expect.objectContaining({
      where: { matchedTechId: "technician-1" },
    }));
  });

  it("allows ADMIN to list all jobs and service requests", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "admin-user", role: "ADMIN" });
    await getJobs(request());
    await getServiceRequests(request());
    expect(mocks.jobs).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    expect(mocks.requests).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});
