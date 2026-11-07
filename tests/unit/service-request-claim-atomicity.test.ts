// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getD1Binding: vi.fn(),
}));

vi.mock("@/lib/idempotency", () => {
  class IdempotencyConflictError extends Error {
    constructor() {
      super("Idempotency-Key was already used with a different payload");
      this.name = "IdempotencyConflictError";
    }
  }
  return {
    getD1Binding: mocks.getD1Binding,
    IdempotencyConflictError,
  };
});

import { IdempotencyConflictError } from "@/lib/idempotency";
import { createServiceRequestAtomically } from "@/lib/service-request-atomic";
import { createInsuranceClaimAtomically } from "@/lib/insurance-claim-atomic";

const serviceInput = {
  idempotencyKey: "service-request:user-1:key-0001",
  requestFingerprint: '{"title":"engine fault"}',
  code: "SR-550E8400-E29B-41D4-A716-446655440000",
  customerId: "customer-1",
  actorUserId: "user-1",
  vehicleId: "vehicle-1",
  category: "engine",
  urgency: "URGENT" as const,
  title: "Engine fault",
  description: "Power loss",
  mediaUrls: "[]",
  voiceNote: null,
  address: "Tehran",
  lat: 35.7,
  lng: 51.4,
};

const claimInput = {
  idempotencyKey: "insurance-claim:user-1:key-0001",
  requestFingerprint: '{"amount":250}',
  code: "CLM-550E8400-E29B-41D4-A716-446655440000",
  policyId: "policy-1",
  jobId: "job-1",
  description: "Accident damage",
  amount: 250,
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));

describe("service request atomic writer", () => {
  it("creates a request against an existing registered vehicle in one Prisma transaction", async () => {
    const tx = {
      serviceRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "request-1" }),
      },
      vehicle: { findUnique: vi.fn().mockResolvedValue({ id: "vehicle-1", customerId: "customer-1", type: "EXCAVATOR", make: "CAT" }) },
    };
    const db = {
      serviceRequest: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(createServiceRequestAtomically(db, serviceInput))
      .resolves.toEqual({ id: "request-1", created: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.vehicle.findUnique).toHaveBeenCalledWith({
      where: { id: "vehicle-1" },
      select: { id: true, customerId: true },
    });
    expect(tx.serviceRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        vehicleId: "vehicle-1",
        idempotencyKey: serviceInput.idempotencyKey,
        requestFingerprint: serviceInput.requestFingerprint,
      }),
    }));
  });

  it("replays the same request and rejects key reuse with a different payload", async () => {
    const db = {
      serviceRequest: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ id: "request-1", requestFingerprint: serviceInput.requestFingerprint })
          .mockResolvedValueOnce({ id: "request-1", requestFingerprint: '{"title":"different"}' }),
      },
      $transaction: vi.fn(),
    } as any;
    await expect(createServiceRequestAtomically(db, serviceInput))
      .resolves.toEqual({ id: "request-1", created: false });
    await expect(createServiceRequestAtomically(db, serviceInput))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("deduplicates 100 concurrent identical requests in the transaction model", async () => {
    const records = new Map<string, { id: string; requestFingerprint: string }>();
    let requestCreates = 0;
    let tail = Promise.resolve();
    const tx = {
      serviceRequest: {
        findUnique: vi.fn(async ({ where }: any) => records.get(where.idempotencyKey) ?? null),
        create: vi.fn(async ({ data }: any) => {
          requestCreates++;
          const row = { id: "request-1", requestFingerprint: data.requestFingerprint };
          records.set(data.idempotencyKey, row);
          return row;
        }),
      },
      vehicle: {
        findUnique: vi.fn(async () => ({ id: "vehicle-1", customerId: "customer-1" })),
      },
    };
    const db = {
      serviceRequest: {
        findUnique: vi.fn(async ({ where }: any) => records.get(where.idempotencyKey) ?? null),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await callback(tx); } finally { release(); }
      }),
    } as any;

    const results = await Promise.all(
      Array.from({ length: 100 }, () => createServiceRequestAtomically(db, serviceInput))
    );
    expect(new Set(results.map((item) => item.id))).toEqual(new Set(["request-1"]));
    expect(requestCreates).toBe(1);
    expect(tx.vehicle.findUnique).toHaveBeenCalled();
  });

  it("uses one D1 insert guarded by the registered vehicle", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => [{ meta: { changes: 1 } }]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("request-d1") });
    const db = {
      serviceRequest: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "request-d1", requestFingerprint: serviceInput.requestFingerprint }),
      },
    } as any;

    await expect(createServiceRequestAtomically(db, serviceInput))
      .resolves.toEqual({ id: "request-d1", created: true });
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(1);
    expect(statements[0].sql).toContain('INSERT INTO "ServiceRequest"');
    expect(statements[0].sql).toContain('FROM "Vehicle"');
    expect(statements[0].values).toContain("vehicle-1");
  });
});

describe("insurance claim atomic writer", () => {
  it("creates the claim and updates policy status in one Prisma transaction", async () => {
    const tx = {
      insuranceClaim: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "claim-1", code: claimInput.code }),
      },
      insurancePolicy: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const db = {
      insuranceClaim: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    await expect(createInsuranceClaimAtomically(db, claimInput))
      .resolves.toEqual({ id: "claim-1", code: claimInput.code, created: true });
    expect(tx.insuranceClaim.create).toHaveBeenCalledTimes(1);
    expect(tx.insurancePolicy.updateMany).toHaveBeenCalledWith({
      where: { id: claimInput.policyId, status: { notIn: ["expired", "cancelled"] }, financialUnitStatus: "VERIFIED_IRR" },
      data: { status: "claimed" },
    });
  });

  it("replays an existing claim without another write and rejects fingerprint mismatch", async () => {
    const db = {
      insuranceClaim: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ id: "claim-1", code: claimInput.code, requestFingerprint: claimInput.requestFingerprint })
          .mockResolvedValueOnce({ id: "claim-1", code: claimInput.code, requestFingerprint: '{"amount":999}' }),
      },
      $transaction: vi.fn(),
    } as any;
    await expect(createInsuranceClaimAtomically(db, claimInput))
      .resolves.toEqual({ id: "claim-1", code: claimInput.code, created: false });
    await expect(createInsuranceClaimAtomically(db, claimInput))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("deduplicates 100 concurrent identical claims in the transaction model", async () => {
    const records = new Map<string, { id: string; code: string; requestFingerprint: string }>();
    let claimCreates = 0;
    let policyUpdates = 0;
    let tail = Promise.resolve();
    const tx = {
      insuranceClaim: {
        findUnique: vi.fn(async ({ where }: any) => records.get(where.idempotencyKey) ?? null),
        create: vi.fn(async ({ data }: any) => {
          claimCreates++;
          const row = { id: "claim-1", code: data.code, requestFingerprint: data.requestFingerprint };
          records.set(data.idempotencyKey, row);
          return row;
        }),
      },
      insurancePolicy: {
        updateMany: vi.fn(async () => {
          policyUpdates++;
          return { count: 1 };
        }),
      },
    };
    const db = {
      insuranceClaim: {
        findUnique: vi.fn(async ({ where }: any) => records.get(where.idempotencyKey) ?? null),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try { return await callback(tx); } finally { release(); }
      }),
    } as any;

    const results = await Promise.all(
      Array.from({ length: 100 }, () => createInsuranceClaimAtomically(db, claimInput))
    );
    expect(new Set(results.map((item) => item.id))).toEqual(new Set(["claim-1"]));
    expect(claimCreates).toBe(1);
    expect(policyUpdates).toBe(1);
  });

  it("uses one D1 batch for claim creation and policy status update", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: () => "claim-d1" });
    const db = {
      insuranceClaim: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: "claim-d1", code: claimInput.code, policyId: claimInput.policyId,
            requestFingerprint: claimInput.requestFingerprint,
          }),
      },
    } as any;

    await expect(createInsuranceClaimAtomically(db, claimInput))
      .resolves.toEqual({ id: "claim-d1", code: claimInput.code, created: true });
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(2);
    expect(statements[0].sql).toContain('INSERT INTO "InsuranceClaim"');
    expect(statements[1].sql).toContain('UPDATE "InsurancePolicy"');
  });
});
