// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoiceFindUnique = vi.fn();
const mockInvoiceUpdate = vi.fn();
const mockJobUpdate = vi.fn();
const mockRequireAuth = vi.fn();
const mockRequireJobParticipant = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    invoice: {
      findUnique: (...args: any[]) => mockInvoiceFindUnique(...args),
      update: (...args: any[]) => mockInvoiceUpdate(...args),
    },
    job: { update: (...args: any[]) => mockJobUpdate(...args) },
  })),
}));
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
}));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: (...args: any[]) => mockRequireJobParticipant(...args),
}));

import { PATCH } from "@/app/api/invoices/[id]/route";

function request(status: string) {
  return new Request("http://localhost/api/invoices/inv-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: "tech-user", role: "TECHNICIAN" });
  mockRequireJobParticipant.mockResolvedValue(null);
  mockInvoiceFindUnique.mockResolvedValue({
    id: "inv-1", jobId: "job-1", status: "SENT", total: 1000, currency: "IRR",
    payment: null,
  });
  mockInvoiceUpdate.mockResolvedValue({ id: "inv-1", status: "CANCELLED" });
});

describe("PATCH /api/invoices/[id] cancellation integrity", () => {
  it.each([
    ["PAID", "SUCCEEDED"],
    ["REFUNDED", "REFUNDED"],
    ["SENT", "SUCCEEDED"],
  ])("refuses cancellation when invoice/payment is settled (%s / %s)", async (status, paymentStatus) => {
    mockInvoiceFindUnique.mockResolvedValueOnce({
      id: "inv-1", jobId: "job-1", status, total: 1000, currency: "IRR",
      payment: { status: paymentStatus },
    });
    const response = await PATCH(request("CANCELLED"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(response.status).toBe(409);
    expect(mockInvoiceUpdate).not.toHaveBeenCalled();
  });

  it("allows cancellation of an unpaid invoice", async () => {
    const response = await PATCH(request("CANCELLED"), { params: Promise.resolve({ id: "inv-1" }) });
    expect(response.status).toBe(200);
    expect(mockInvoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "inv-1" },
      data: { status: "CANCELLED" },
    }));
  });
});
