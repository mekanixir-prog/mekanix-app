// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  participant: vi.fn(),
  technicianSession: vi.fn(),
  jobFind: vi.fn(),
  jobUpdate: vi.fn(),
  technicianUpdate: vi.fn(),
  notificationCreate: vi.fn(),
  messageCreate: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: mocks.participant,
  getTechnicianFromSession: mocks.technicianSession,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    job: { findUnique: mocks.jobFind, updateMany: mocks.jobUpdate },
    technician: { updateMany: mocks.technicianUpdate },
    notification: { create: mocks.notificationCreate },
    message: { create: mocks.messageCreate },
    walletTransaction: { updateMany: vi.fn() },
  }),
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
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
  mocks.participant.mockResolvedValue(null);
  mocks.technicianSession.mockResolvedValue({ id: "tech-1" });
  mocks.jobFind.mockResolvedValueOnce({ status: "REQUESTED", technicianId: "tech-1" })
    .mockResolvedValue(job);
  mocks.jobUpdate.mockResolvedValue({ count: 1 });
  mocks.technicianUpdate.mockResolvedValue({ count: 1 });
  mocks.notificationCreate.mockResolvedValue({});
  mocks.messageCreate.mockResolvedValue({});
});

describe("job terminal transitions release technician capacity", () => {
  it("returns a rejected technician to ONLINE after the request is reopened", async () => {
    const response = await PATCH(makeRequest("REJECTED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.technicianUpdate).toHaveBeenCalledWith({
      where: {
        id: "tech-1",
        status: "ON_JOB",
        jobsAssigned: {
          none: {
            status: {
              in: [
                "REQUESTED", "ACCEPTED", "EN_ROUTE", "ARRIVED",
                "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL",
              ],
            },
          },
        },
      },
      data: { status: "ONLINE" },
    });
  });

  it("releases a technician when a customer cancels before arrival", async () => {
    mocks.auth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
    const response = await PATCH(makeRequest("CANCELLED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.technicianUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "tech-1", status: "ON_JOB" }),
      data: { status: "ONLINE" },
    }));
  });

  it("does not attempt to release a technician for a non-terminal transition", async () => {
    const response = await PATCH(makeRequest("ACCEPTED"), { params: Promise.resolve({ id: "job-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.technicianUpdate).not.toHaveBeenCalled();
  });
});
