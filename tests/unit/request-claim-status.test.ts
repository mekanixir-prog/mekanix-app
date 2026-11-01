// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  customer: vi.fn(),
  serviceRequest: vi.fn(),
  insuranceClaim: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({ getCustomerFromSession: mocks.customer }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    serviceRequest: { findUnique: mocks.serviceRequest },
    insuranceClaim: { findUnique: mocks.insuranceClaim },
  }),
}));

import { GET as getServiceRequestStatus } from "@/app/api/service-requests/status/route";
import { GET as getInsuranceClaimStatus } from "@/app/api/insurance/claim/status/route";

const session = { userId: "user-1", role: "CUSTOMER" };
const request = (path: string) => new Request(`https://mekanix.test${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(session);
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.serviceRequest.mockResolvedValue({
    id: "request-1",
    code: "SR-550E8400-E29B-41D4-A716-446655440000",
    customerId: "customer-1",
    vehicleId: "vehicle-1",
    vehicle: { id: "vehicle-1", customerId: "customer-1" },
  });
  mocks.insuranceClaim.mockResolvedValue({
    id: "claim-1",
    code: "CLM-550E8400-E29B-41D4-A716-446655440000",
    policyId: "policy-1",
    policy: { userId: "user-1", status: "claimed" },
  });
});

describe("service request reconciliation status", () => {
  it("reports COMMITTED only when the linked vehicle belongs to the same customer", async () => {
    const response = await getServiceRequestStatus(request("/api/service-requests/status?key=retry-key-123"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "COMMITTED",
      request: { id: "request-1" },
    });
  });

  it("requires reconciliation when the request has a missing or mismatched vehicle", async () => {
    mocks.serviceRequest.mockResolvedValue({
      id: "request-1", code: "SR-1", customerId: "customer-1",
      vehicleId: "vehicle-1", vehicle: null,
    });
    const response = await getServiceRequestStatus(request("/api/service-requests/status?key=retry-key-123"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ state: "RECONCILIATION_REQUIRED" });
  });

  it("returns NOT_COMMITTED when no request exists for the key", async () => {
    mocks.serviceRequest.mockResolvedValue(null);
    const response = await getServiceRequestStatus(request("/api/service-requests/status?key=retry-key-123"));
    await expect(response.json()).resolves.toMatchObject({ state: "NOT_COMMITTED", retryAllowed: true });
  });

  it("rejects malformed keys before database access", async () => {
    const response = await getServiceRequestStatus(request("/api/service-requests/status?key=x"));
    expect(response.status).toBe(400);
    expect(mocks.serviceRequest).not.toHaveBeenCalled();
  });
});

describe("insurance claim reconciliation status", () => {
  it("reports COMMITTED only when claim and policy status agree", async () => {
    const response = await getInsuranceClaimStatus(request("/api/insurance/claim/status?key=retry-key-123"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "COMMITTED",
      claim: { id: "claim-1", policyId: "policy-1" },
    });
  });

  it("requires reconciliation when policy status was not advanced", async () => {
    mocks.insuranceClaim.mockResolvedValue({
      id: "claim-1", code: "CLM-1", policyId: "policy-1",
      policy: { userId: "user-1", status: "active" },
    });
    const response = await getInsuranceClaimStatus(request("/api/insurance/claim/status?key=retry-key-123"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ state: "RECONCILIATION_REQUIRED" });
  });

  it("returns NOT_COMMITTED when the claim does not exist", async () => {
    mocks.insuranceClaim.mockResolvedValue(null);
    const response = await getInsuranceClaimStatus(request("/api/insurance/claim/status?key=retry-key-123"));
    await expect(response.json()).resolves.toMatchObject({ state: "NOT_COMMITTED", retryAllowed: true });
  });

  it("does not disclose a claim owned by another user", async () => {
    mocks.insuranceClaim.mockResolvedValue({
      id: "claim-1", code: "CLM-1", policyId: "policy-1",
      policy: { userId: "user-2", status: "claimed" },
    });
    const response = await getInsuranceClaimStatus(request("/api/insurance/claim/status?key=retry-key-123"));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ state: "KEY_CONFLICT" });
  });
});
