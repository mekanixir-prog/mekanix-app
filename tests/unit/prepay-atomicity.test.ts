// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { recordPrepayWithD1, recordPrepayWithPrisma } from "@/lib/prepay-atomic";

const input = {
  jobId: "job-1",
  jobCode: "JOB-100001",
  technicianId: "tech-1",
  gross: 1000,
  commission: 100,
  net: 900,
  inspectionFee: 600,
  travelFee: 400,
  paidAt: new Date("2026-10-30T08:00:00.000Z"),
  machineLabel: "heavy" as const,
};

describe("atomic prepay recording", () => {
  it("writes the job marker, two transactions, two ledger rows and wallet totals in one Prisma transaction", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      wallet: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 50, totalEarned: 0, totalCommission: 0, totalWithdrawn: 0, financialUnitStatus: "VERIFIED_IRR" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
    expect(tx.walletLedger.create).toHaveBeenCalledTimes(2);
    expect(tx.walletLedger.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        amount: -100,
        balanceBefore: 950,
        balanceAfter: 950,
      }),
    });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: {
        id: "wallet-1",
        financialUnitStatus: "VERIFIED_IRR",
        balance: 0,
        pendingBalance: 50,
        totalEarned: 0,
        totalCommission: 0,
        totalWithdrawn: 0,
      },
      data: {
        pendingBalance: { increment: 900 },
        totalEarned: { increment: 1000 },
        totalCommission: { increment: 100 },
      },
    });
  });

  it("rejects a verified wallet with a negative aggregate before creating financial rows", async () => {
    const tx = {
      job: { updateMany: vi.fn() },
      wallet: {
        upsert: vi.fn().mockResolvedValue({
          id: "wallet-1", balance: 0, pendingBalance: -1,
          totalEarned: 0, totalCommission: 0, totalWithdrawn: 0,
          financialUnitStatus: "VERIFIED_IRR",
        }),
        updateMany: vi.fn(),
      },
      walletTransaction: { create: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).resolves.toBe(false);
    expect(tx.job.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("does not create financial rows when another request won the job transition", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      wallet: { upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 0, totalEarned: 0, totalCommission: 0, totalWithdrawn: 0, financialUnitStatus: "VERIFIED_IRR" }), updateMany: vi.fn() },
      walletTransaction: { create: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).resolves.toBe(false);
    expect(tx.wallet.upsert).toHaveBeenCalledTimes(1);
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("promotes only a pristine zero-balance UNVERIFIED wallet before the first prepay", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      wallet: {
        upsert: vi.fn().mockResolvedValue({
          id: "wallet-1", balance: 0, pendingBalance: 0,
          totalEarned: 0, totalCommission: 0, totalWithdrawn: 0,
          financialUnitStatus: "UNVERIFIED",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).resolves.toBe(true);
    expect(tx.wallet.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        financialUnitStatus: "UNVERIFIED",
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalCommission: 0,
        totalWithdrawn: 0,
        transactions: { none: {} },
        ledger: { none: {} },
        withdrawals: { none: {} },
      }),
      data: { financialUnitStatus: "VERIFIED_IRR" },
    }));
    expect(tx.wallet.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ financialUnitStatus: "VERIFIED_IRR", totalWithdrawn: 0 }),
    }));
  });

  it("refuses to mutate an existing wallet without verified IRR provenance", async () => {
    const tx = {
      job: { updateMany: vi.fn() },
      wallet: {
        upsert: vi.fn().mockResolvedValue({
          id: "wallet-1", balance: 0, pendingBalance: 100,
          totalEarned: 0, totalCommission: 0, totalWithdrawn: 0, financialUnitStatus: "UNVERIFIED",
        }),
        updateMany: vi.fn(),
      },
      walletTransaction: { create: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).resolves.toBe(false);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.job.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("aborts if the pending balance changed after the ledger snapshot", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      wallet: {
        upsert: vi.fn().mockResolvedValue({
          id: "wallet-1",
          balance: 0,
          pendingBalance: 50,
          totalEarned: 0,
          totalCommission: 0,
          totalWithdrawn: 0,
          financialUnitStatus: "VERIFIED_IRR",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input))
      .rejects.toThrow("Verified IRR wallet aggregate update failed");
    expect(tx.wallet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ pendingBalance: 50 }),
    }));
  });

  it("propagates a ledger failure so the Prisma transaction rolls back", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      wallet: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 0, totalEarned: 0, totalCommission: 0, totalWithdrawn: 0, financialUnitStatus: "VERIFIED_IRR" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      walletLedger: {
        create: vi.fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error("ledger insert failed")),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(recordPrepayWithPrisma(db, input)).rejects.toThrow("ledger insert failed");
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it("submits all D1 financial writes in one batch and checks every expected change", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn().mockResolvedValue(
        Array.from({ length: 16 }, () => ({ meta: { changes: 1 } }))
      ),
    };

    await expect(recordPrepayWithD1(d1 as any, input)).resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(16);
    expect(statements[6].sql).toContain("changes() = 1");
    expect(statements[5].sql).toContain('"idempotencyKey"');
    expect(statements[9].sql).toContain("'HOLD'");
    expect(statements.some((statement) => statement.sql.includes("totalWithdrawn") && statement.sql.includes(">= 0"))).toBe(true);
  });

  it("does not report success when the guarded Job update loses a race", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("malformed JSON assertion failed")),
    };

    await expect(recordPrepayWithD1(d1 as any, input)).resolves.toBe(false);
  });

  it("propagates D1 batch errors", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("D1 batch aborted")),
    };

    await expect(recordPrepayWithD1(d1 as any, input)).rejects.toThrow("D1 batch aborted");
  });
});
