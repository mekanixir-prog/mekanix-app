// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getD1Binding: vi.fn(),
  jobFindUnique: vi.fn(),
  jobUpdateMany: vi.fn(),
  invoiceFindUnique: vi.fn(),
  partCreate: vi.fn(),
  partFindUnique: vi.fn(),
  partDelete: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  addJobPartBeforeInvoice,
  removeJobPartBeforeInvoice,
  JobPartMutationConflictError,
  JobPartNotFoundError,
} from "@/lib/job-parts-atomic";

const tx = {
  job: { findUnique: mocks.jobFindUnique, updateMany: mocks.jobUpdateMany },
  invoice: { findUnique: mocks.invoiceFindUnique },
  part: {
    create: mocks.partCreate,
    findUnique: mocks.partFindUnique,
    delete: mocks.partDelete,
  },
};
const db = {
  $transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  job: { findUnique: mocks.jobFindUnique },
  part: { findUnique: mocks.partFindUnique },
} as never;

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getD1Binding.mockResolvedValue(null);
  mocks.jobFindUnique.mockResolvedValue({ status: "REPAIRING", updatedAt: new Date("2026-11-06T10:00:00.000Z") });
  mocks.jobUpdateMany.mockResolvedValue({ count: 1 });
  mocks.invoiceFindUnique.mockResolvedValue(null);
  mocks.partCreate.mockResolvedValue({ id: "part-1", jobId: "job-1" });
  mocks.partFindUnique.mockResolvedValue({ id: "part-1", jobId: "job-1" });
  mocks.partDelete.mockResolvedValue({});
});

describe("atomic job part mutation", () => {
  it("adds a verified IRR part only while the job is in REPAIRING and has no invoice", async () => {
    const part = await addJobPartBeforeInvoice(db, {
      jobId: "job-1",
      name: "Oil filter",
      sku: "OF-1",
      quantity: 2,
      unitPrice: 1_500_000,
    });
    expect(part).toMatchObject({ id: "part-1", jobId: "job-1" });
    expect(mocks.jobFindUnique).toHaveBeenCalledWith({ where: { id: "job-1" }, select: { status: true, updatedAt: true } });
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", status: "REPAIRING", updatedAt: new Date("2026-11-06T10:00:00.000Z") },
    }));
    expect(mocks.invoiceFindUnique).toHaveBeenCalledWith({
      where: { jobId: "job-1" },
      select: { id: true },
    });
    expect(mocks.partCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: "job-1",
        name: "Oil filter",
        quantity: 2,
        unitPrice: 1_500_000,
        financialUnitStatus: "VERIFIED_IRR",
      }),
    });
  });

  it("rejects part changes if the status transition already won the race", async () => {
    mocks.jobUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(addJobPartBeforeInvoice(db, {
      jobId: "job-1", name: "Oil filter", sku: null, quantity: 1, unitPrice: 100,
    })).rejects.toBeInstanceOf(JobPartMutationConflictError);
    expect(mocks.partCreate).not.toHaveBeenCalled();
  });

  it("rejects part changes when an invoice already exists", async () => {
    mocks.invoiceFindUnique.mockResolvedValueOnce({ id: "invoice-1" });
    await expect(addJobPartBeforeInvoice(db, {
      jobId: "job-1", name: "Oil filter", sku: null, quantity: 1, unitPrice: 100,
    })).rejects.toBeInstanceOf(JobPartMutationConflictError);
    expect(mocks.partCreate).not.toHaveBeenCalled();
  });

  it("deletes a part only while the job is still editable", async () => {
    await expect(removeJobPartBeforeInvoice(db, "job-1", "part-1")).resolves.toBeUndefined();
    expect(mocks.partDelete).toHaveBeenCalledWith({ where: { id: "part-1" } });
  });

  it("uses a conditional D1 batch and reads back the inserted part", async () => {
    const statement = { bind: vi.fn() };
    statement.bind.mockReturnValue(statement);
    const d1 = { prepare: vi.fn((_sql: string) => statement), batch: vi.fn().mockResolvedValue([]) };
    mocks.getD1Binding.mockResolvedValueOnce(d1);
    mocks.partFindUnique.mockResolvedValueOnce({ id: "d1-part", jobId: "job-1" });

    const part = await addJobPartBeforeInvoice(db, {
      jobId: "job-1", name: "Oil filter", sku: null, quantity: 1, unitPrice: 1_000_000,
    });

    expect(part).toMatchObject({ id: "d1-part", jobId: "job-1" });
    expect(d1.prepare.mock.calls[0][0]).toContain('UPDATE "Job"');
    expect(d1.prepare.mock.calls[2][0]).toContain('INSERT INTO "Part"');
    expect(d1.prepare.mock.calls[2][0]).toContain('status" = \'REPAIRING\'');
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(4);
  });

  it("maps a failed D1 conditional insert to a conflict instead of a server error", async () => {
    const statement = { bind: vi.fn() };
    statement.bind.mockReturnValue(statement);
    const d1 = { prepare: vi.fn((_sql: string) => statement), batch: vi.fn().mockRejectedValue(new Error("malformed JSON")) };
    mocks.getD1Binding.mockResolvedValueOnce(d1);
    await expect(addJobPartBeforeInvoice(db, {
      jobId: "job-1", name: "Oil filter", sku: null, quantity: 1, unitPrice: 1_000_000,
    })).rejects.toBeInstanceOf(JobPartMutationConflictError);
  });

  it("returns not found when a part belongs to another job or is missing", async () => {
    mocks.partFindUnique.mockResolvedValueOnce(null);
    await expect(removeJobPartBeforeInvoice(db, "job-1", "missing")).rejects.toBeInstanceOf(JobPartNotFoundError);
    expect(mocks.partDelete).not.toHaveBeenCalled();
  });
});
