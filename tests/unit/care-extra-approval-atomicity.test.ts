// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  CareExtraApprovalConflictError,
  decideCareExtraApprovalAtomically,
} from "@/lib/care-extra-approval-atomic";

const input = {
  bookingId: "booking-1",
  approvalId: "approval-1",
  findingId: "finding-1",
  actorUserId: "customer-user-1",
  decision: "CUSTOMER_APPROVED" as const,
};

beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("CARE extra approval atomic writer", () => {
  it("updates approval, booking, finding, and timeline in one Prisma transaction", async () => {
    const updatedApproval = { id: input.approvalId, status: "CUSTOMER_APPROVED" };
    const tx = {
      customerApproval: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(updatedApproval),
      },
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      finding: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      serviceTimelineEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(decideCareExtraApprovalAtomically(db, input)).resolves.toEqual(updatedApproval);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.customerApproval.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.approvalId,
        bookingId: input.bookingId,
        status: "PROPOSED",
        findingId: input.findingId,
        finding: { is: { id: input.findingId, bookingId: input.bookingId } },
      },
      data: {
        status: "CUSTOMER_APPROVED",
        approvedAt: expect.any(Date),
        rejectedAt: null,
      },
    });
    expect(tx.serviceBooking.updateMany).toHaveBeenCalledWith({
      where: { id: input.bookingId, status: "WAITING_CUSTOMER_APPROVAL" },
      data: { status: "APPROVED", updatedAt: expect.any(Date) },
    });
    expect(tx.finding.updateMany).toHaveBeenCalledWith({
      where: { id: input.findingId, bookingId: input.bookingId },
      data: { status: "APPROVED" },
    });
    expect(tx.serviceTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: input.bookingId,
        eventType: "customer_approved",
        actor: input.actorUserId,
        metadata: JSON.stringify({ approvalId: input.approvalId }),
      }),
    });
  });

  it("stops before booking mutation when the proposal has already been decided", async () => {
    const tx = {
      customerApproval: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn() },
      serviceBooking: { updateMany: vi.fn() },
      finding: { updateMany: vi.fn() },
      serviceTimelineEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(decideCareExtraApprovalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(tx.serviceBooking.updateMany).not.toHaveBeenCalled();
    expect(tx.serviceTimelineEvent.create).not.toHaveBeenCalled();
  });

  it("rolls back the approval claim if the booking is no longer awaiting approval", async () => {
    const tx = {
      customerApproval: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      finding: { updateMany: vi.fn() },
      serviceTimelineEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(decideCareExtraApprovalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(tx.finding.updateMany).not.toHaveBeenCalled();
    expect(tx.serviceTimelineEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a finding that no longer belongs to the booking", async () => {
    const tx = {
      customerApproval: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      finding: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      serviceTimelineEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(decideCareExtraApprovalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(tx.serviceTimelineEvent.create).not.toHaveBeenCalled();
  });

  it("uses one D1 batch for all approval decision writes", async () => {
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
        { meta: { changes: 1 } }, { meta: { changes: 0 } },
      ]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("event-id") });
    const db = {
      customerApproval: { findUnique: vi.fn().mockResolvedValue({ id: input.approvalId, status: input.decision }) },
    } as any;

    await expect(decideCareExtraApprovalAtomically(db, input))
      .resolves.toMatchObject({ id: input.approvalId, status: input.decision });
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(8);
    expect(statements[0].sql).toContain('UPDATE "CustomerApproval"');
    expect(statements[0].sql).toContain('"findingId" IS ?');
    expect(statements[1].sql).toContain("json_extract('not-json'");
    expect(statements[2].sql).toContain('UPDATE "ServiceBooking"');
    expect(statements[3].sql).toContain("json_extract('not-json'");
    expect(statements[4].sql).toContain('UPDATE "Finding"');
    expect(statements[5].sql).toContain("json_extract('not-json'");
    expect(statements[6].sql).toContain('INSERT INTO "ServiceTimelineEvent"');
    expect(statements[7].sql).toContain("json_extract('not-json'");
  });

  it("rejects D1 decision batches when the compare-and-set precondition fails", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async () => { throw new Error("malformed JSON"); }),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = { customerApproval: { findUnique: vi.fn() } } as any;

    await expect(decideCareExtraApprovalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(db.customerApproval.findUnique).not.toHaveBeenCalled();
  });
});
