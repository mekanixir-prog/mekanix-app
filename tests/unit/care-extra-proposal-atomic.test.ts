// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import { createCareExtraProposalAtomically } from "@/lib/care-extra-proposal-atomic";

const input = {
  bookingId: "booking-1",
  expectedBookingStatus: "INSPECTING" as const,
  actorRole: "TECHNICIAN" as const,
  actorUserId: "tech-user-1",
  actorTechnicianId: "tech-1",
  proposal: {
    proposedItem: "Hydraulic hose",
    partPrice: 1_200_000,
    quantity: 2,
    laborPrice: 800_000,
    findingId: null,
  },
  details: {
    description: "Replace hose",
    partName: "Hydraulic hose",
    partBrand: "OEM",
    partNumber: "H-100",
    partType: "OEM",
    imageUrl: null,
    technicianNote: null,
  },
  newFinding: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getD1Binding.mockResolvedValue(null);
});

describe("atomic CARE extra proposal IRR provenance", () => {
  it("persists canonical IRR amounts with VERIFIED_IRR in the Prisma transaction", async () => {
    const approval = {
      id: "approval-1",
      financialUnitStatus: "VERIFIED_IRR",
      partPrice: 1_200_000,
      laborPrice: 800_000,
      totalPrice: 3_200_000,
    };
    const tx = {
      serviceBooking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customerApproval: { create: vi.fn().mockResolvedValue(approval) },
      serviceTimelineEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(createCareExtraProposalAtomically(db, input)).resolves.toEqual(approval);
    expect(tx.customerApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        partPrice: 1_200_000,
        laborPrice: 800_000,
        totalPrice: 3_200_000,
        financialUnitStatus: "VERIFIED_IRR",
      }),
    });
  });

  it("writes the IRR attestation in the same D1 batch as the approval", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    mocks.getD1Binding.mockResolvedValueOnce(d1);
    const approval = { id: "approval-d1", financialUnitStatus: "VERIFIED_IRR" };
    const db = { customerApproval: { findUnique: vi.fn().mockResolvedValue(approval) } } as any;

    await expect(createCareExtraProposalAtomically(db, input)).resolves.toEqual(approval);
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO "CustomerApproval"'));
    expect(insert?.sql).toContain('"financialUnitStatus"');
    expect(insert?.sql).toContain("'VERIFIED_IRR'");
    expect(d1.batch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-integer or unsafe canonical IRR amounts before any write", async () => {
    const db = { $transaction: vi.fn() } as any;
    await expect(createCareExtraProposalAtomically(db, {
      ...input,
      proposal: { ...input.proposal, partPrice: 1.5 },
    })).rejects.toThrow("safe non-negative integer IRR");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
