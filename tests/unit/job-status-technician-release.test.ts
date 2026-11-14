// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  participant: vi.fn(),
  technicianSession: vi.fn(),
  jobFind: vi.fn(),
  transition: vi.fn(),
  notificationCreate: vi.fn(),
  messageCreate: vi.fn(),
  taxFind: vi.fn(),
  calculatePrice: vi.fn(),
  partsVerified: vi.fn(),
  serviceCode: vi.fn(),
  travelDistance: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: mocks.participant,
  getTechnicianFromSession: mocks.technicianSession,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    job: { findUnique: mocks.jobFind },
    notification: { create: mocks.notificationCreate },
    message: { create: mocks.messageCreate },
    walletTransaction: { updateMany: vi.fn() },
    platformSetting: { findUnique: mocks.taxFind },
  }),
}));
vi.mock("@/lib/pricing", () => ({ calculatePrice: mocks.calculatePrice }));
vi.mock("@/lib/money/provenance", () => ({ areJobPartPriceSourcesVerified: mocks.partsVerified }));
vi.mock("@/lib/job-invoice-pricing", () => ({
  serviceCodeFromCategory: mocks.serviceCode,
  estimateTravelDistanceKm: mocks.travelDistance,
}));
vi.mock("@/lib/job-status-atomic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/job-status-atomic")>();
  return {
    ...actual,
    transitionJobStatusAtomically: mocks.transition,
  };
});

import { PATCH } from "@/app/api/jobs/[id]/status/route";

const job = {
  id: "job-1",
  code: "JOB-1",
  etaMins: 20,
  status: "REJECTED",
  parts: [],
  invoice: null,
  request: { customer: { user: { id: "customer-user", name: "Customer" } } },
  technician: { id: "technician-user", user: { id: "technician-user", name: "Technician" } },
};

function makeRequest(status: string) {
  return new Request("https://mekanix.test/api/jobs/job-1/status", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.auth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
  mocks.participant.mockResolvedValue(null);
  mocks.technicianSession.mockResolvedValue({ id: "tech-1" });
  mocks.jobFind.mockResolvedValueOnce({
    status: "REQUESTED",
    updatedAt: new Date("2026-11-06T10:00:00.000Z"),
    technicianId: "tech-1",
    requestId: "request-1",
  }).mockResolvedValue(job);
  mocks.transition.mockResolvedValue(undefined);
  mocks.notificationCreate.mockResolvedValue({});
  mocks.messageCreate.mockResolvedValue({});
  mocks.taxFind.mockResolvedValue(null);
  mocks.calculatePrice.mockResolvedValue({
    labor: 8_000_000, parts: 2_000_000, travel: 5_000_000, inspection: 600_000,
    emergency: 0, discount: 0, subtotal: 15_600_000, taxRate: 0, taxTotal: 0,
    total: 15_600_000, currency: "IRR", pricingVersion: "rate-card-7",
    breakdown: { extraDistanceBillingEnabled: false, billableExtraKm: 0 },
  });
  mocks.partsVerified.mockReturnValue(true);
  mocks.serviceCode.mockReturnValue("diagnostic");
  mocks.travelDistance.mockReturnValue(0);
});

describe("job status route delegates atomic state changes", () => {
  it("atomically reopens the request and releases the technician on REJECTED", async () => {
    const response = await PATCH(makeRequest("REJECTED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      jobId: "job-1",
      requestId: "request-1",
      technicianId: "tech-1",
      actorRole: "TECHNICIAN",
      actorTechnicianId: "tech-1",
      currentStatus: "REQUESTED",
      nextStatus: "REJECTED",
      updates: {},
    }));
  });

  it("atomically cancels the request and releases the technician on customer cancellation", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
    const response = await PATCH(makeRequest("CANCELLED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      requestId: "request-1",
      actorRole: "CUSTOMER",
      actorTechnicianId: null,
      nextStatus: "CANCELLED",
    }));
  });

  it("uses fixed rate-card components when repair preparation enters customer approval", async () => {
    const repair = {
      status: "REPAIRING",
      updatedAt: new Date("2026-11-06T10:00:00.000Z"),
      technicianId: "tech-1",
      requestId: "request-1",
      technician: {
        id: "tech-1",
        user: { id: "technician-user", name: "Technician" },
      },
      parts: [{ unitPrice: 1_000_000, quantity: 2 }],
      invoice: null,
      request: {
        category: "diagnostic",
        urgency: "NORMAL",
        lat: 35.7,
        lng: 51.4,
        vehicle: { type: "CAR" },
        customer: { user: { id: "customer-user", name: "Customer" } },
      },
      tracking: [{ lat: 35.7, lng: 51.4 }],
    };
    mocks.jobFind.mockReset();
    mocks.jobFind.mockResolvedValueOnce(repair).mockResolvedValue(job);
    const request = new Request("https://mekanix.test/api/jobs/job-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "WAITING_APPROVAL", laborHours: 1.5 }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.calculatePrice).toHaveBeenCalledWith({
      vehicleType: "CAR", serviceCode: "diagnostic", laborHours: 0,
      partsCost: 2_000_000, travelDistanceKm: 0, isEmergency: false,
    });
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      invoice: expect.objectContaining({
        laborHours: 1,
        laborRate: 8_000_000,
        laborTotal: 8_000_000,
        partsTotal: 2_000_000,
        travelFee: 5_000_000,
        inspectionFee: 600_000,
        emergencyFee: 0,
        subtotal: 15_600_000,
        taxRate: 0,
        taxTotal: 0,
        total: 15_600_000,
        currency: "IRR",
        pricingVersion: "rate-card-7",
        financialUnitStatus: "VERIFIED_IRR",
      }),
    }));
  });

  it("fails closed when the rate-card calculator is unavailable during estimate preparation", async () => {
    const repair = {
      status: "REPAIRING",
      technicianId: "tech-1",
      requestId: "request-1",
      technician: {
        id: "tech-1",
        user: { id: "technician-user", name: "Technician" },
      },
      parts: [{ unitPrice: 1_000_000, quantity: 2 }],
      invoice: null,
      request: {
        category: "diagnostic",
        urgency: "NORMAL",
        lat: 35.7,
        lng: 51.4,
        vehicle: { type: "CAR" },
        customer: { user: { id: "customer-user", name: "Customer" } },
      },
      tracking: [{ lat: 35.7, lng: 51.4 }],
    };
    mocks.jobFind.mockReset();
    mocks.jobFind.mockResolvedValueOnce(repair);
    mocks.calculatePrice.mockRejectedValueOnce(new Error("Production pricing is not approved"));
    const request = new Request("https://mekanix.test/api/jobs/job-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "WAITING_APPROVAL", laborHours: 1.5 }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(409);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("delegates non-terminal transitions without requesting technician release", async () => {
    const response = await PATCH(makeRequest("ACCEPTED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      actorRole: "TECHNICIAN",
      actorTechnicianId: "tech-1",
      nextStatus: "ACCEPTED",
      updates: { startedAt: expect.any(Date) },
    }));
  });
});
