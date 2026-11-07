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
  status: "REPAIRING",
  customerApproved: false,
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
  financialUnitStatus: "UNVERIFIED",
  travelFee: 123_000,
  inspectionFee: 456_000,
  technician: { financialUnitStatus: "UNVERIFIED", hourlyRate: 900_000, user: { id: "technician-user-1", name: "Technician" } },
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
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      financialUnitStatus: "UNVERIFIED",
      travelFee: null,
      inspectionFee: null,
      technician: { hourlyRate: null, financialUnitStatus: "UNVERIFIED" },
    });
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
    expect(atomicInput.invoice.notes).toContain("هزینه رفت‌وآمد");
    expect(atomicInput.invoice.notes).toContain("تأیید این پیش‌فاکتور");
    expect(atomicInput.invoice.notes).not.toContain("6-month");
  });

  it("does not reopen approval for an estimate that was already issued", async () => {
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "REPAIRING",
      invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" },
      customerApproved: true,
    });
    const response = await PATCH(request({ status: "WAITING_APPROVAL" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ESTIMATE_ALREADY_ISSUED" });
    expect(mocks.transition).not.toHaveBeenCalled();
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

  it("allows a customer to approve an estimate without changing the job status", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user-1", role: "CUSTOMER" });
    const waitingApproval = { ...beforeJob, status: "WAITING_APPROVAL", invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" } };
    const updated = { ...updatedJob, status: "WAITING_APPROVAL" };
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce(waitingApproval).mockResolvedValueOnce(updated);

    const response = await PATCH(request({ customerApproved: true }), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      actorRole: "CUSTOMER",
      currentStatus: "WAITING_APPROVAL",
      nextStatus: "WAITING_APPROVAL",
      updates: { customerApproved: true },
    }));
  });

  it("rejects non-Boolean customer approval values", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user-1", role: "CUSTOMER" });
    const response = await PATCH(request({ customerApproved: "false" }), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_APPROVAL_INVALID" });
    expect(mocks.jobFindUnique).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("rejects a customer approval combined with a job status jump", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user-1", role: "CUSTOMER" });
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "WAITING_APPROVAL",
    });

    const response = await PATCH(request({
      status: "COMPLETED",
      customerApproved: true,
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "REPAIR_NOT_STARTED" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("does not let a technician impersonate customer approval", async () => {
    mocks.auth.mockResolvedValue({ userId: "technician-user-1", role: "TECHNICIAN" });
    const response = await PATCH(request({
      status: "REPAIRING",
      customerApproved: true,
    }), { params: Promise.resolve({ id: "job-1" }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_APPROVAL_FORBIDDEN" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("allows the technician to enter pre-estimate preparation after diagnosis", async () => {
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "DIAGNOSING",
      invoice: null,
      customerApproved: false,
    });

    const response = await PATCH(request({ status: "REPAIRING" }), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      actorRole: "TECHNICIAN",
      currentStatus: "DIAGNOSING",
      nextStatus: "REPAIRING",
      updates: {},
    }));
  });

  it("blocks completion when no verified estimate exists", async () => {
    const response = await PATCH(request({ status: "COMPLETED" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "REPAIR_ESTIMATE_REQUIRED" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("blocks completion until the customer has approved the verified estimate", async () => {
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "REPAIRING",
      customerApproved: false,
      invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" },
    });
    const response = await PATCH(request({ status: "COMPLETED" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_APPROVAL_REQUIRED" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("allows completion after the customer approves the verified estimate", async () => {
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "REPAIRING",
      customerApproved: true,
      invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" },
    }).mockResolvedValueOnce({ ...updatedJob, status: "COMPLETED" });
    const response = await PATCH(request({ status: "COMPLETED" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      currentStatus: "REPAIRING",
      nextStatus: "COMPLETED",
      updates: { completedAt: expect.any(Date) },
    }));
  });

  it("allows a technician to start repair after stored customer approval", async () => {
    const waitingApproval = { ...beforeJob, status: "WAITING_APPROVAL", customerApproved: true, invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" } };
    const repairing = { ...updatedJob, status: "REPAIRING" };
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce(waitingApproval).mockResolvedValueOnce(repairing);

    const response = await PATCH(request({ status: "REPAIRING" }), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      actorRole: "TECHNICIAN",
      currentStatus: "WAITING_APPROVAL",
      nextStatus: "REPAIRING",
      updates: {},
    }));
  });

  it("rejects direct repair from an earlier dispatch stage", async () => {
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({ ...beforeJob, status: "ARRIVED" });
    const response = await PATCH(request({ status: "REPAIRING" }), {
      params: Promise.resolve({ id: "job-1" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "REPAIR_ESTIMATE_REQUIRED" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("does not let a technician start repair before the stored customer approval", async () => {
    mocks.auth.mockResolvedValue({ userId: "technician-user-1", role: "TECHNICIAN" });
    mocks.jobFindUnique.mockReset().mockResolvedValueOnce({
      ...beforeJob,
      status: "WAITING_APPROVAL",
      customerApproved: false,
      invoice: { id: "invoice-1", currency: "IRR", financialUnitStatus: "VERIFIED_IRR" },
    });

    const response = await PATCH(request({ status: "REPAIRING" }), {
      params: Promise.resolve({ id: "job-1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CUSTOMER_APPROVAL_REQUIRED" });
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
