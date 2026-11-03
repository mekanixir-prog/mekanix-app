// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import { createVipSubscriptionAtomically } from "@/lib/vip-subscription-atomic";

const input = {
  userId: "user-1",
  planId: "plan-1",
  paymentId: "payment-1",
  startedAt: new Date("2026-11-02T10:00:00.000Z"),
  expiresAt: new Date("2026-12-02T10:00:00.000Z"),
};

beforeEach(() => mocks.getD1Binding.mockResolvedValue(null));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("atomic VIP subscription replacement", () => {
  it("cancels the previous active subscription and creates the new one in one Prisma transaction", async () => {
    const tx = {
      userVipSubscription: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ id: "subscription-1" }),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<string>) => callback(tx)),
    } as any;

    await expect(createVipSubscriptionAtomically(db, input)).resolves.toBe("subscription-1");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.userVipSubscription.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    expect(tx.userVipSubscription.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        planId: "plan-1",
        status: "ACTIVE",
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
        paymentId: "payment-1",
      },
      select: { id: true },
    });
  });

  it("propagates creation failure from inside the transaction", async () => {
    const tx = {
      userVipSubscription: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockRejectedValue(new Error("insert failed")),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<string>) => callback(tx)),
    } as any;

    await expect(createVipSubscriptionAtomically(db, input)).rejects.toThrow("insert failed");
    expect(tx.userVipSubscription.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.userVipSubscription.create).toHaveBeenCalledTimes(1);
  });

  it("uses one D1 batch and asserts the insert inside the batch", async () => {
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
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("subscription-uuid") });
    const db = {} as any;

    await expect(createVipSubscriptionAtomically(db, input)).resolves.toBe("subscription-uuid");
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(3);
    expect(statements[0].sql).toContain('UPDATE "UserVipSubscription"');
    expect(statements[1].sql).toContain('INSERT INTO "UserVipSubscription"');
    expect(statements[2].sql).toContain("json_extract");
  });

  it("does not hide a failed D1 batch", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn(async (_statements: unknown[]) => { throw new Error("UNIQUE constraint failed"); }),
    };
    mocks.getD1Binding.mockResolvedValue(d1);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("subscription-uuid") });

    await expect(createVipSubscriptionAtomically({} as any, input))
      .rejects.toThrow("UNIQUE constraint failed");
  });
});
