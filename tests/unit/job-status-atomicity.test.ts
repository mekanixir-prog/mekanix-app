// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  JobStatusConflictError,
  transitionJobStatusAtomically,
} from "@/lib/job-status-atomic";

const input = {
  jobId: "job-1",
  requestId: "request-1",
  technicianId: "technician-1",
  actorRole: "TECHNICIAN" as const,
  actorTechnicianId: "technician-1",
  currentStatus: "REQUESTED",
  expectedUpdatedAt: new Date("2026-11-06T10:00:00.000Z"),
  nextStatus: "REJECTED",
  updates: {},
} as const;

beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("atomic job status writer", () => {
  it("updates the job, reopens the request, and releases the technician in one Prisma transaction", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      technician: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(transitionJobStatusAtomically(db, input)).resolves.toBeUndefined();
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.jobId,
        status: input.currentStatus,
        technicianId: input.actorTechnicianId,
        request: { is: { id: input.requestId, matchedTechId: input.technicianId } },
      },
      data: { status: "REJECTED" },
    });
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: { id: input.requestId, matchedTechId: input.technicianId },
      data: { status: "OPEN", matchedTechId: null },
    });
    expect(tx.technician.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.technicianId,
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

  it("does not update the request when the job status compare-and-set loses", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      serviceRequest: { updateMany: vi.fn() },
      technician: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(transitionJobStatusAtomically(db, input))
      .rejects.toBeInstanceOf(JobStatusConflictError);
    expect(tx.serviceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.technician.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back the job transition when the linked request cannot be changed", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      technician: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(transitionJobStatusAtomically(db, input))
      .rejects.toBeInstanceOf(JobStatusConflictError);
    expect(tx.technician.updateMany).not.toHaveBeenCalled();
  });

  it("uses only scalar job updates for ACCEPTED and keeps the request unchanged", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      serviceRequest: { updateMany: vi.fn() },
      technician: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;
    const acceptedInput = {
      ...input,
      nextStatus: "ACCEPTED" as const,
      updates: { startedAt: new Date("2026-11-01T09:00:00.000Z") },
    };

    await expect(transitionJobStatusAtomically(db, acceptedInput)).resolves.toBeUndefined();
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: input.jobId, status: input.currentStatus, technicianId: input.actorTechnicianId },
      data: { status: "ACCEPTED", startedAt: acceptedInput.updates.startedAt },
    });
    expect(tx.serviceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.technician.updateMany).not.toHaveBeenCalled();
  });

  it("creates the approval invoice inside the same Prisma transaction as WAITING_APPROVAL", async () => {
    const invoice = {
      id: "invoice-1",
      code: "INV-123456789ABC",
      jobId: input.jobId,
      laborHours: 1,
      laborRate: 18_000_000,
      laborTotal: 18_000_000,
      partsTotal: 10_000_000,
      travelFee: 5_000_000,
      inspectionFee: 6_000_000,
      emergencyFee: 0,
      subtotal: 39_000_000,
      taxRate: 0,
      taxTotal: 0,
      discount: 0,
      total: 39_000_000,
      currency: "IRR",
      pricingVersion: "rate-card-2",
      financialUnitStatus: "VERIFIED_IRR" as const,
      status: "SENT" as const,
      notes: "Fixed-fee rate card rate-card-2; service periodic. Warranty terms follow the approved service agreement.",
    };
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      invoice: { create: vi.fn().mockResolvedValue(invoice) },
      serviceRequest: { updateMany: vi.fn() },
      technician: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(transitionJobStatusAtomically(db, {
      ...input,
      nextStatus: "WAITING_APPROVAL",
      invoice,
    })).resolves.toBeUndefined();
    expect(tx.invoice.create).toHaveBeenCalledWith({ data: invoice });
    expect(invoice).toMatchObject({ inspectionFee: 6_000_000, emergencyFee: 0, financialUnitStatus: "VERIFIED_IRR" });
  });

  it("sets the escrow hold in the same transaction as job completion", async () => {
    const holdUntil = new Date("2026-11-03T12:00:00.000Z");
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      walletTransaction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      technician: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      serviceRequest: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(transitionJobStatusAtomically(db, {
      ...input,
      currentStatus: "REPAIRING",
      nextStatus: "COMPLETED",
      holdUntil,
    })).resolves.toBeUndefined();
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledWith({
      where: { jobId: input.jobId, status: "PENDING" },
      data: { holdUntil },
    });
  });

  it("uses one D1 batch for job, request, and technician updates", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => []),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = {} as any;

    await expect(transitionJobStatusAtomically(db, input)).resolves.toBeUndefined();
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(5);
    expect(statements[0].sql).toContain('UPDATE "Job"');
    expect(statements[0].values.slice(-5)).toEqual([
      input.jobId,
      input.currentStatus,
      input.actorTechnicianId,
      input.requestId,
      input.technicianId,
    ]);
    expect(statements[1].sql).toContain("json_extract");
    expect(statements[2].sql).toContain('UPDATE "ServiceRequest"');
    expect(statements[3].sql).toContain("json_extract");
    expect(statements[4].sql).toContain('UPDATE "Technician"');
  });

  it("inserts the invoice and asserts it inside the same D1 batch", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => []),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const invoice = {
      id: "invoice-1",
      code: "INV-123456789ABC",
      jobId: input.jobId,
      laborHours: 1,
      laborRate: 18_000_000,
      laborTotal: 18_000_000,
      partsTotal: 10_000_000,
      travelFee: 5_000_000,
      inspectionFee: 6_000_000,
      emergencyFee: 0,
      subtotal: 39_000_000,
      taxRate: 0,
      taxTotal: 0,
      discount: 0,
      total: 39_000_000,
      currency: "IRR",
      pricingVersion: "rate-card-2",
      financialUnitStatus: "VERIFIED_IRR" as const,
      status: "SENT" as const,
      notes: "Fixed-fee rate card rate-card-2; service periodic. Warranty terms follow the approved service agreement.",
    };

    await expect(transitionJobStatusAtomically({} as any, {
      ...input,
      nextStatus: "WAITING_APPROVAL",
      invoice,
    })).resolves.toBeUndefined();

    expect(d1.batch.mock.calls[0][0]).toHaveLength(4);
    expect(statements[2].sql).toContain('INSERT INTO "Invoice"');
    expect(statements[2].sql).toContain('"inspectionFee"');
    expect(statements[2].sql).toContain('"emergencyFee"');
    expect(statements[2].sql).toContain('"financialUnitStatus"');
    expect(statements[2].values).toHaveLength(25);
    expect(statements[2].values).toContain("invoice-1");
    expect(statements[2].values).toContain(6_000_000);
    expect(statements[2].values).toContain("VERIFIED_IRR");
    expect(statements[2].values).toContain("rate-card-2");
    expect(statements[3].sql).toContain("json_extract");
  });

  it("does not release a technician for non-terminal status changes", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async (_statements: unknown[]) => [{ meta: { changes: 1 } }]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = {} as any;
    const acceptedInput = { ...input, nextStatus: "ACCEPTED" as const, updates: { startedAt: new Date() } };

    await expect(transitionJobStatusAtomically(db, acceptedInput)).resolves.toBeUndefined();
    expect(d1.batch.mock.calls[0][0]).toHaveLength(2);
  });

  it("returns a conflict when the D1 job compare-and-set fails", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async (_statements: unknown[]) => { throw new Error("malformed JSON"); }),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = {} as any;

    await expect(transitionJobStatusAtomically(db, input))
      .rejects.toBeInstanceOf(JobStatusConflictError);
  });
});
