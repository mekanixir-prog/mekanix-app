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
        upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 50, totalEarned: 0, totalCommission: 0, financialUnitStatus: "VERIFIED_IRR" }),
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
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", financialUnitStatus: "VERIFIED_IRR" },
      data: {
        pendingBalance: { increment: 900 },
        totalEarned: { increment: 1000 },
        totalCommission: { increment: 100 },
      },
    });
  });

  it("does not create wallet or ledger rows when another request won the job transition", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      wallet: { upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 0, totalEarned: 0, totalCommission: 0, financialUnitStatus: "VERIFIED_IRR" }), updateMany: vi.fn() },
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

  it("propagates a ledger failure so the Prisma transaction rolls back", async () => {
    const tx = {
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      wallet: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet-1", balance: 0, pendingBalance: 0, totalEarned: 0, totalCommission: 0, financialUnitStatus: "VERIFIED_IRR" }),
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
        Array.from({ length: 15 }, () => ({ meta: { changes: 1 } }))
      ),
    };

    await expect(recordPrepayWithD1(d1 as any, input)).resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(15);
    expect(statements[5].sql).toContain("changes() = 1");
    expect(statements[2].sql).toContain('"idempotencyKey"');
    expect(statements[8].sql).toContain("'HOLD'");
    expect(statements[10].sql).toContain("financialUnitStatus");
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
