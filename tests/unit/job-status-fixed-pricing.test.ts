// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  participant: vi.fn(),
  technician: vi.fn(),
  jobFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
  messageCreate: vi.fn(),
  calculatePrice: vi.fn(),
  partsVerified: vi.fn(),
  serviceCode: vi.fn(),
  travelDistance: vi.fn(),
  transition: vi.fn(),
}));
vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: mocks.participant,
  getTechnicianFromSession: mocks.technician,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    job: { findUnique: mocks.jobFindUnique },
    notification: { create: mocks.notificationCreate },
    message: { create: mocks.messageCreate },
  })),
}));
vi.mock("@/lib/pricing", () => ({ calculatePrice: mocks.calculatePrice }));
vi.mock("@/lib/money/provenance", () => ({ areJobPartPriceSourcesVerified: mocks.partsVerified }));
vi.mock("@/lib/job-invoice-pricing", () => ({
  serviceCodeFromCategory: mocks.serviceCode,
  estimateTravelDistanceKm: mocks.travelDistance,
}));
vi.mock("@/lib/job-status-atomic", () => ({
  JobStatusConflictError: class JobStatusConflictError extends Error {},
  transitionJobStatusAtomically: mocks.transition,
}));

import { PATCH } from "@/app/api/jobs/[id]/status/route";

const beforeJob = {
  status: "DIAGNOSING",
  updatedAt: new Date("2026-11-06T10:00:00.000Z"),
  technicianId: "tech-1",
  requestId: "request-1",
  code: "JOB-1",
  parts: [{ unitPrice: 1_000_000, quantity: 1 }],
  request: {
    category: "diagnostic",
    urgency: "NORMAL",
    lat: 35.7,
    lng: 51.4,
    vehicle: { type: "CAR" },
  },
  tracking: [{ lat: 35.7, lng: 51.4 }],
};
const updatedJob = {
  id: "job-1",
  code: "JOB-1",
  status: "WAITING_APPROVAL",
  etaMins: 20,
  request: { customer: { user: { id: "customer-user-1" } } },
  technician: { user: { id: "technician-user-1", name: "Technician" } },
};
const pricing = {
  labor: 8_000_000,
  parts: 1_000_000,
  travel: 5_000_000,
  inspection: 6_000_000,
  emergency: 0,
  discount: 0,
  subtotal: 20_000_000,
  taxRate: 0,
  taxTotal: 0,
  total: 20_000_000,
  currency: "IRR",
  pricingVersion: "rate-card-7",
  breakdown: { includedDistanceKm: 10 },
};

function request(body: unknown) {
  return new Request("https://mekanix.test/api/jobs/job-1/status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.auth.mockResolvedValue({ userId: "tech-user-1", role: "TECHNICIAN" });
  mocks.participant.mockResolvedValue(null);
  mocks.technician.mockResolvedValue({ id: "tech-1" });
  mocks.jobFindUnique.mockResolvedValueOnce(beforeJob).mockResolvedValueOnce(updatedJob);
  mocks.notificationCreate.mockResolvedValue({});
  mocks.messageCreate.mockResolvedValue({});
  mocks.calculatePrice.mockResolvedValue(pricing);
  mocks.partsVerified.mockReturnValue(true);
  mocks.serviceCode.mockReturnValue("diagnostic");
  mocks.travelDistance.mockReturnValue(0);
  mocks.transition.mockResolvedValue(undefined);
});

describe("job status approval estimate uses the fixed rate card", () => {
  it("ignores legacy hourly inputs and atomically snapshots fixed IRR components", async () => {
    const response = await PATCH(request({
      status: "WAITING_APPROVAL",
      laborHours: 24,
      laborRate: 1,
      taxRate: 0.09,
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.calculatePrice).toHaveBeenCalledWith({
      vehicleType: "CAR",
      serviceCode: "diagnostic",
      laborHours: 0,
      partsCost: 1_000_000,
      travelDistanceKm: 0,
      isEmergency: false,
    });
    const atomicInput = mocks.transition.mock.calls[0][1];
    expect(atomicInput.invoice).toMatchObject({
      laborHours: 1,
      laborRate: 8_000_000,
      laborTotal: 8_000_000,
      partsTotal: 1_000_000,
      travelFee: 5_000_000,
      inspectionFee: 6_000_000,
      emergencyFee: 0,
      subtotal: 20_000_000,
      taxRate: 0,
      taxTotal: 0,
      total: 20_000_000,
      currency: "IRR",
      pricingVersion: "rate-card-7",
      financialUnitStatus: "VERIFIED_IRR",
    });
    expect(atomicInput.invoice.notes).not.toContain("6-month");
  });

  it("blocks estimates when legacy parts do not have approved IRR provenance", async () => {
    mocks.partsVerified.mockReturnValue(false);
    const response = await PATCH(request({ status: "WAITING_APPROVAL" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "JOB_PART_CURRENCY_UNVERIFIED" });
    expect(mocks.calculatePrice).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("blocks unknown service categories instead of guessing a diagnostic fee", async () => {
    mocks.serviceCode.mockReturnValue(null);
    const response = await PATCH(request({ status: "WAITING_APPROVAL" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SERVICE_RATE_MAPPING_REQUIRED" });
    expect(mocks.calculatePrice).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
