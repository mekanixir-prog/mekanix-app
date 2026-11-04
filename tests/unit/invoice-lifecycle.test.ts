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
    platformSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    servicePackage: { findUnique: vi.fn().mockResolvedValue(null) },
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
};

const pricingJob = {
  id: "job-1",
  status: "WAITING_APPROVAL",
  parts: [{ unitPrice: 100, quantity: 2 }],
  technician: { hourlyRate: 200, travelFeeBase: 50, lat: null, lng: null },
  tracking: [],
  request: { category: "diagnostic", urgency: "NORMAL", lat: 35.7, lng: 51.4, vehicle: { type: "CAR" } },
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
  mocks.taxFindUnique.mockResolvedValue(null);
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

  it("creates an invoice using fixed IRR labor, dispatch, and inspection rates", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce(pricingJob).mockResolvedValueOnce(refreshedJob);

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(200);
    const payload = mocks.invoiceCreate.mock.calls[0][0].data;
    expect(payload).toMatchObject({
      laborHours: 1,
      laborRate: 8_000_000,
      laborTotal: 8_000_000,
      partsTotal: 200,
      travelFee: 5_000_000,
      inspectionFee: 6_000_000,
      emergencyFee: 0,
      subtotal: 19_000_200,
      taxRate: 0,
      taxTotal: 0,
      total: 19_000_200,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
    });
  });

  it("persists and exposes emergency surcharge separately from fixed labor", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce({
      ...pricingJob,
      request: { ...pricingJob.request, urgency: "EMERGENCY" },
    }).mockResolvedValueOnce(refreshedJob);

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(200);
    expect(mocks.invoiceCreate.mock.calls[0][0].data).toMatchObject({
      laborTotal: 8_000_000,
      emergencyFee: 2_400_000,
      subtotal: 21_400_200,
      total: 21_400_200,
    });
  });

  it("fails closed when a service category has no tariff mapping", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce({
      ...pricingJob,
      request: { ...pricingJob.request, category: "unknown-service" },
    });

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SERVICE_RATE_MAPPING_REQUIRED" });
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("requires explicit minor or major classification for engine repairs", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce({
      ...pricingJob,
      request: { ...pricingJob.request, category: "engine repair" },
    });

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SERVICE_RATE_MAPPING_REQUIRED" });
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("does not issue an invoice before the job reaches post-repair approval", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce({ ...pricingJob, status: "IN_SERVICE" });

    const response = await createInvoice(postRequest({ jobId: "job-1" }));
    expect(response.status).toBe(409);
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("ignores client-supplied hourly values and keeps the server fixed-fee tariff", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce(null);
    mocks.jobFindUnique.mockResolvedValueOnce(pricingJob).mockResolvedValueOnce(refreshedJob);

    const response = await createInvoice(postRequest({ jobId: "job-1", laborHours: 22, laborRate: 1 }));
    expect(response.status).toBe(200);
    expect(mocks.invoiceCreate.mock.calls[0][0].data.laborHours).toBe(1);
    expect(mocks.invoiceCreate.mock.calls[0][0].data.laborTotal).toBe(8_000_000);
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
