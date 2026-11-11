// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  participant: vi.fn(),
  technician: vi.fn(),
  invoiceFindUnique: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceUpdate: vi.fn(),
  invoiceUpdateMany: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdateMany: vi.fn(),
  taxFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
  messageCreate: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: mocks.participant,
  getTechnicianFromSession: mocks.technician,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    invoice: {
      findUnique: mocks.invoiceFindUnique,
      create: mocks.invoiceCreate,
      update: mocks.invoiceUpdate,
      updateMany: mocks.invoiceUpdateMany,
    },
    job: {
      findUnique: mocks.jobFindUnique,
      updateMany: mocks.jobUpdateMany,
    },
    platformSetting: { findUnique: mocks.taxFindUnique },
    notification: { create: mocks.notificationCreate },
    message: { create: mocks.messageCreate },
  })),
}));

import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as patchInvoice } from "@/app/api/invoices/[id]/route";

function postRequest(body: unknown) {
  return new Request("https://mekanix.test/api/invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown) {
  return new Request("https://mekanix.test/api/invoices/inv-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const existingInvoice = {
  id: "inv-1",
  jobId: "job-1",
  code: "INV-EXISTING",
  status: "SENT",
  total: 1200,
  currency: "IRR",
  financialUnitStatus: "VERIFIED_IRR",
};

const pricingJob = {
  id: "job-1",
  status: "WAITING_APPROVAL",
  parts: [{ unitPrice: 100, quantity: 2 }],
  technician: { hourlyRate: 200, travelFeeBase: 50 },
};

const refreshedJob = {
  id: "job-1",
  request: { customer: { user: { id: "customer-1", name: "Customer" } } },
  technician: { user: { id: "technician-user-1", name: "Technician" } },
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.auth.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
  mocks.participant.mockResolvedValue(null);
  mocks.technician.mockResolvedValue(null);
  mocks.invoiceFindUnique.mockResolvedValue(null);
  mocks.invoiceCreate.mockResolvedValue(existingInvoice);
  mocks.invoiceUpdate.mockResolvedValue(existingInvoice);
  mocks.invoiceUpdateMany.mockResolvedValue({ count: 1 });
  mocks.jobFindUnique.mockResolvedValue(pricingJob);
  mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.taxFindUnique.mockResolvedValue({ value: "0.09" });
  mocks.notificationCreate.mockResolvedValue({});
  mocks.messageCreate.mockResolvedValue({});
});

describe("POST /api/invoices lifecycle", () => {
  it("returns the invoice already created by the current-main job-status flow", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(existingInvoice);

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(existingInvoice);
    expect(mocks.jobFindUnique).not.toHaveBeenCalled();
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("returns the winning invoice when concurrent issuance loses the unique jobId race", async () => {
    mocks.invoiceFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingInvoice);
    mocks.jobFindUnique
      .mockResolvedValueOnce(pricingJob)
      .mockResolvedValueOnce(refreshedJob);
    const uniqueError = Object.assign(new Error("unique constraint"), { code: "P2002" });
    mocks.invoiceCreate.mockRejectedValueOnce(uniqueError);

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(existingInvoice);
    expect(mocks.invoiceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.notificationCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed tax settings instead of persisting a corrupt invoice total", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.taxFindUnique.mockResolvedValueOnce({ value: "0.09garbage" });

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(mocks.jobFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.taxFindUnique).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ error: "تنظیمات مالیات نامعتبر است" });
    expect(response.status).toBe(503);
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("does not issue an invoice before the job reaches post-repair approval", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce({ ...pricingJob, status: "IN_SERVICE" });

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(409);
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("rejects non-finite or out-of-range labor hours", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);

    const response = await createInvoice(postRequest({ jobId: "job-1", laborHours: "2" }));
    expect(response.status).toBe(400);
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/invoices/[id] status transitions", () => {
  it("rejects CANCELLED because it is not a supported InvoiceStatus", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce({ ...existingInvoice, status: "SENT" });

    const response = await patchInvoice(patchRequest({ status: "CANCELLED" }), {
      params: Promise.resolve({ id: "inv-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.invoiceUpdate).not.toHaveBeenCalled();
    expect(mocks.invoiceUpdateMany).not.toHaveBeenCalled();
  });

  it("cannot cancel a PAID invoice", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce({ ...existingInvoice, status: "PAID" });

    const response = await patchInvoice(patchRequest({ status: "CANCELLED" }), {
      params: Promise.resolve({ id: "inv-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.invoiceUpdate).not.toHaveBeenCalled();
    expect(mocks.invoiceUpdateMany).not.toHaveBeenCalled();
  });

  it("uses compare-and-set for DRAFT to SENT and returns 409 on a lost race", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce({ ...existingInvoice, status: "DRAFT" });
    mocks.invoiceUpdateMany.mockResolvedValueOnce({ count: 0 });

    const response = await patchInvoice(patchRequest({ status: "SENT" }), {
      params: Promise.resolve({ id: "inv-1" }),
    });
    expect(response.status).toBe(409);
    expect(mocks.invoiceUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", status: "DRAFT" },
      data: { status: "SENT" },
    });
  });

  it("commits the supported DRAFT to SENT transition once", async () => {
    mocks.invoiceFindUnique
      .mockResolvedValueOnce({ ...existingInvoice, status: "DRAFT" })
      .mockResolvedValueOnce({ ...existingInvoice, status: "SENT" });

    const response = await patchInvoice(patchRequest({ status: "SENT" }), {
      params: Promise.resolve({ id: "inv-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ status: "SENT" });
  });
});
