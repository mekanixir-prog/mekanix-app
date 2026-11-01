// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  assignServiceRequestAtomically,
  ServiceRequestAssignmentConflictError,
} from "@/lib/service-request-assignment";

const input = {
  requestId: "request-1",
  technicianId: "technician-1",
  category: "hydraulic",
  etaMins: 24,
  existingRejectedJobId: null,
};

beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("service request assignment atomic writer", () => {
  it("claims the request and technician and creates the job in one Prisma transaction", async () => {
    const tx = {
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      technician: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      job: { create: vi.fn().mockResolvedValue({ id: "job-1" }) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(assignServiceRequestAtomically(db, input)).resolves.toBeUndefined();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: { id: input.requestId, status: "OPEN", matchedTechId: null, job: { is: null } },
      data: { status: "ASSIGNED", matchedTechId: input.technicianId },
    });
    expect(tx.technician.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.technicianId,
        status: "ONLINE",
        verified: true,
        availableNow: true,
        user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
        specialties: { some: { category: input.category } },
      },
      data: { status: "ON_JOB" },
    });
    expect(tx.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: input.requestId,
        technicianId: input.technicianId,
        status: "REQUESTED",
        etaMins: input.etaMins,
      }),
    });
  });

  it("reuses the rejected Job row when assigning a replacement technician", async () => {
    const tx = {
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      technician: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;
    const reassignmentInput = { ...input, existingRejectedJobId: "job-rejected" };

    await expect(assignServiceRequestAtomically(db, reassignmentInput)).resolves.toBeUndefined();
    expect(tx.serviceRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.requestId,
        status: "OPEN",
        matchedTechId: null,
        job: { is: { id: "job-rejected", status: "REJECTED" } },
      },
      data: { status: "ASSIGNED", matchedTechId: input.technicianId },
    });
    expect(tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: "job-rejected", requestId: input.requestId, status: "REJECTED" },
      data: expect.objectContaining({
        technicianId: input.technicianId,
        status: "REQUESTED",
        etaMins: input.etaMins,
        customerApproved: false,
        startedAt: null,
        completedAt: null,
      }),
    });
    expect(tx.job.create).not.toHaveBeenCalled();
  });

  it("does not claim a technician or create a job when the request is already claimed", async () => {
    const tx = {
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      technician: { updateMany: vi.fn() },
      job: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(assignServiceRequestAtomically(db, input))
      .rejects.toBeInstanceOf(ServiceRequestAssignmentConflictError);
    expect(tx.technician.updateMany).not.toHaveBeenCalled();
    expect(tx.job.create).not.toHaveBeenCalled();
  });

  it("rolls back the request claim when the technician is no longer eligible", async () => {
    const tx = {
      serviceRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      technician: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      job: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(assignServiceRequestAtomically(db, input))
      .rejects.toBeInstanceOf(ServiceRequestAssignmentConflictError);
    expect(tx.job.create).not.toHaveBeenCalled();
  });

  it("uses one D1 batch for request claim, technician claim, and Job creation", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => [
        { meta: { changes: 1 } }, { meta: { changes: 0 } },
        { meta: { changes: 1 } }, { meta: { changes: 0 } },
        { meta: { changes: 1 } }, { meta: { changes: 0 } },
      ]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("job-random-id") });
    const db = { job: { findUnique: vi.fn().mockResolvedValue({ id: "job-1" }) } } as any;

    await expect(assignServiceRequestAtomically(db, input)).resolves.toBeUndefined();
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(6);
    expect(statements[0].sql).toContain('UPDATE "ServiceRequest"');
    expect(statements[0].sql).toContain('"status" = \'OPEN\'');
    expect(statements[0].sql).toContain('"verified" = 1');
    expect(statements[0].sql).toContain('"availableNow" = 1');
    expect(statements[1].sql).toContain("json_extract('not-json'");
    expect(statements[2].sql).toContain('UPDATE "Technician"');
    expect(statements[3].sql).toContain("json_extract('not-json'");
    expect(statements[4].sql).toContain('INSERT INTO "Job"');
    expect(statements[5].sql).toContain("json_extract('not-json'");
  });

  it("updates a previously rejected Job inside the D1 batch instead of inserting a duplicate", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = { job: { findUnique: vi.fn().mockResolvedValue({ id: "job-rejected" }) } } as any;

    await expect(assignServiceRequestAtomically(db, {
      ...input,
      existingRejectedJobId: "job-rejected",
    })).resolves.toBeUndefined();
    expect(statements[0].sql).toContain('j."status" = \'REJECTED\'');
    expect(statements[2].sql).toContain('UPDATE "Job"');
    expect(statements[2].sql).toContain('"status" = \'REQUESTED\'');
  });

  it("rejects a D1 batch when any compare-and-set step loses a race", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async () => { throw new Error("malformed JSON"); }),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = { job: { findUnique: vi.fn() } } as any;

    await expect(assignServiceRequestAtomically(db, input))
      .rejects.toBeInstanceOf(ServiceRequestAssignmentConflictError);
    expect(db.job.findUnique).not.toHaveBeenCalled();
  });
});
