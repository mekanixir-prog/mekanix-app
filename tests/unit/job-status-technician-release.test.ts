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
vi.mock("@/lib/job-status-atomic", () => ({
  JobStatusConflictError: class JobStatusConflictError extends Error {},
  transitionJobStatusAtomically: mocks.transition,
}));

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
    technicianId: "tech-1",
    requestId: "request-1",
  }).mockResolvedValue(job);
  mocks.transition.mockResolvedValue(undefined);
  mocks.notificationCreate.mockResolvedValue({});
  mocks.messageCreate.mockResolvedValue({});
  mocks.taxFind.mockResolvedValue({ value: "0.09" });
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

  it("uses the configured validated tax rate when the repair enters customer approval", async () => {
    const repair = {
      status: "REPAIRING",
      technicianId: "tech-1",
      requestId: "request-1",
      technician: {
        id: "tech-1",
        hourlyRate: 200,
        travelFeeBase: 50,
        user: { id: "technician-user", name: "Technician" },
      },
      parts: [{ unitPrice: 100, quantity: 2 }],
      invoice: null,
      request: { customer: { user: { id: "customer-user", name: "Customer" } } },
    };
    mocks.jobFind.mockReset();
    mocks.jobFind.mockResolvedValueOnce(repair).mockResolvedValue(job);
    mocks.taxFind.mockResolvedValueOnce({ value: "0.12" });
    const request = new Request("https://mekanix.test/api/jobs/job-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "WAITING_APPROVAL", laborHours: 1.5 }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.transition).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      invoice: expect.objectContaining({
        laborHours: 1.5,
        subtotal: 550,
        taxRate: 0.12,
        taxTotal: 66,
        total: 616,
      }),
    }));
  });

  it("fails closed when the configured tax rate is malformed", async () => {
    const repair = {
      status: "REPAIRING",
      technicianId: "tech-1",
      requestId: "request-1",
      technician: {
        id: "tech-1",
        hourlyRate: 200,
        travelFeeBase: 50,
        user: { id: "technician-user", name: "Technician" },
      },
      parts: [{ unitPrice: 100, quantity: 2 }],
      invoice: null,
      request: { customer: { user: { id: "customer-user", name: "Customer" } } },
    };
    mocks.jobFind.mockReset();
    mocks.jobFind.mockResolvedValueOnce(repair);
    mocks.taxFind.mockResolvedValueOnce({ value: "0.09invalid" });
    const request = new Request("https://mekanix.test/api/jobs/job-1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "WAITING_APPROVAL", laborHours: 1.5 }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(503);
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
