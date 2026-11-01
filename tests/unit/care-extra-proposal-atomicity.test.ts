// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  CareExtraProposalConflictError,
  createCareExtraProposalAtomically,
} from "@/lib/care-extra-proposal-atomic";

const input = {
  bookingId: "booking-1",
  expectedBookingStatus: "INSPECTING" as const,
  actorUserId: "technician-user-1",
  proposal: {
    proposedItem: "Hydraulic hose replacement",
    partPrice: 120_000,
    quantity: 2,
    laborPrice: 80_000,
    findingId: null,
  },
  details: {
    description: "Replace damaged hose",
    partName: "Hydraulic hose",
    partBrand: "OEM",
    partNumber: "H-100",
    partType: "OEM",
    imageUrl: null,
    technicianNote: "Leak confirmed",
  },
  newFinding: {
    category: "hydraulic",
    title: "Hydraulic hose leak",
    description: "Leak near connector",
    severity: "HIGH",
  },
};

beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("CARE extra proposal atomic writer", () => {
  it("commits booking transition, new finding, approval, and timeline in one Prisma transaction", async () => {
    const approval = { id: "approval-1", status: "PROPOSED" };
    const tx = {
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      finding: { create: vi.fn().mockResolvedValue({ id: "finding-created" }), findFirst: vi.fn() },
      customerApproval: { create: vi.fn().mockResolvedValue(approval) },
      serviceTimelineEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(createCareExtraProposalAtomically(db, input)).resolves.toEqual(approval);
    expect(tx.serviceBooking.updateMany).toHaveBeenCalledWith({
      where: { id: input.bookingId, status: "INSPECTING" },
      data: { status: "WAITING_CUSTOMER_APPROVAL", updatedAt: expect.any(Date) },
    });
    expect(tx.finding.create).toHaveBeenCalledWith({
      data: { bookingId: input.bookingId, ...input.newFinding },
      select: { id: true },
    });
    expect(tx.customerApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: input.bookingId,
        findingId: "finding-created",
        proposedItem: input.proposal.proposedItem,
        quantity: 2,
        partPrice: 120_000,
        laborPrice: 80_000,
        totalPrice: 320_000,
        status: "PROPOSED",
      }),
    });
    expect(tx.serviceTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: input.bookingId,
        eventType: "extra_proposal",
        actor: input.actorUserId,
        metadata: JSON.stringify({ approvalId: approval.id }),
      }),
    });
  });

  it("revalidates an existing finding against the booking inside the transaction", async () => {
    const approval = { id: "approval-2", status: "PROPOSED" };
    const tx = {
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      finding: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue({ id: "finding-1" }) },
      customerApproval: { create: vi.fn().mockResolvedValue(approval) },
      serviceTimelineEvent: { create: vi.fn().mockResolvedValue({ id: "event-2" }) },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;
    const existingFindingInput = {
      ...input,
      proposal: { ...input.proposal, findingId: "finding-1" },
      newFinding: null,
    };

    await expect(createCareExtraProposalAtomically(db, existingFindingInput)).resolves.toEqual(approval);
    expect(tx.finding.findFirst).toHaveBeenCalledWith({
      where: { id: "finding-1", bookingId: input.bookingId },
      select: { id: true },
    });
    expect(tx.finding.create).not.toHaveBeenCalled();
    expect(tx.customerApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ findingId: "finding-1" }),
    });
  });

  it("does not create a finding or approval when the booking state compare-and-set loses", async () => {
    const tx = {
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      finding: { create: vi.fn(), findFirst: vi.fn() },
      customerApproval: { create: vi.fn() },
      serviceTimelineEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;

    await expect(createCareExtraProposalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraProposalConflictError);
    expect(tx.finding.create).not.toHaveBeenCalled();
    expect(tx.customerApproval.create).not.toHaveBeenCalled();
    expect(tx.serviceTimelineEvent.create).not.toHaveBeenCalled();
  });

  it("rolls back when an existing finding belongs to another booking", async () => {
    const tx = {
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      finding: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      customerApproval: { create: vi.fn() },
      serviceTimelineEvent: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) } as any;
    const existingFindingInput = {
      ...input,
      proposal: { ...input.proposal, findingId: "foreign-finding" },
      newFinding: null,
    };

    await expect(createCareExtraProposalAtomically(db, existingFindingInput))
      .rejects.toBeInstanceOf(CareExtraProposalConflictError);
    expect(tx.customerApproval.create).not.toHaveBeenCalled();
    expect(tx.serviceTimelineEvent.create).not.toHaveBeenCalled();
  });

  it("uses one D1 batch with a unique timeline marker to gate every write", async () => {
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
        { meta: { changes: 1 } },
      ]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn()
        .mockReturnValueOnce("approval-id")
        .mockReturnValueOnce("timeline-id")
        .mockReturnValueOnce("finding-id"),
    });
    const db = {
      customerApproval: { findUnique: vi.fn().mockResolvedValue({ id: "approval-id" }) },
    } as any;

    await expect(createCareExtraProposalAtomically(db, input))
      .resolves.toMatchObject({ id: "approval-id" });
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(4);
    expect(statements[0].sql).toContain('INSERT INTO "ServiceTimelineEvent"');
    expect(statements[0].sql).toContain('"idempotencyKey"');
    expect(statements[1].sql).toContain('UPDATE "ServiceBooking"');
    expect(statements[2].sql).toContain('INSERT INTO "Finding"');
    expect(statements[3].sql).toContain('INSERT INTO "CustomerApproval"');
  });

  it("rejects a stale D1 booking without committing dependent rows", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async (_statements: unknown[]) => [
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
      ]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("id") });
    const db = { customerApproval: { findUnique: vi.fn() } } as any;

    await expect(createCareExtraProposalAtomically(db, input))
      .rejects.toBeInstanceOf(CareExtraProposalConflictError);
    expect(db.customerApproval.findUnique).not.toHaveBeenCalled();
  });
});
