// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  updateWithdrawalWithD1,
  updateWithdrawalWithPrisma,
} from "@/lib/withdrawal-admin-atomic";

const input = {
  withdrawalId: "wd-1",
  action: "REJECTED" as const,
  adminId: "admin-1",
  adminNotes: "اطلاعات بانکی ناقص است",
  at: new Date("2026-10-30T10:00:00.000Z"),
};

describe("admin withdrawal transitions", () => {
  it("approves only a REQUESTED withdrawal", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "wd-1", walletId: "wallet-1", amount: 500, status: "REQUESTED" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(updateWithdrawalWithPrisma(db, { ...input, action: "APPROVED" })).resolves.toBe(true);
    expect(tx.withdrawalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "wd-1", status: "REQUESTED" },
      data: { status: "APPROVED", reviewerId: "admin-1", adminNotes: input.adminNotes },
    });
  });

  it("refunds a rejected withdrawal and records the refund ledger in one transaction", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "wd-1", walletId: "wallet-1", amount: 500, status: "APPROVED" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ balance: 1500 }),
      },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(updateWithdrawalWithPrisma(db, input)).resolves.toBe(true);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1" },
      data: { balance: { increment: 500 } },
    });
    expect(tx.walletLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "REFUND",
        amount: 500,
        balanceBefore: 1000,
        balanceAfter: 1500,
        referenceType: "Withdrawal",
        referenceId: "wd-1",
        idempotencyKey: "withdrawal:wd-1:REJECT_REFUND",
        createdBy: "admin-1",
      }),
    });
  });

  it("rolls back rejection if the refund ledger cannot be written", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "wd-1", walletId: "wallet-1", amount: 500, status: "REQUESTED" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ balance: 1500 }),
      },
      walletLedger: { create: vi.fn().mockRejectedValue(new Error("ledger failed")) },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(updateWithdrawalWithPrisma(db, input)).rejects.toThrow("ledger failed");
  });

  it("marks an approved request paid, creates one payout transaction and updates totalWithdrawn", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "wd-1", walletId: "wallet-1", amount: 500, status: "APPROVED" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: { create: vi.fn().mockResolvedValue({}) },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(updateWithdrawalWithPrisma(db, { ...input, action: "PAID" })).resolves.toBe(true);
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: "wallet-1",
        kind: "PAYOUT",
        status: "COMPLETED",
        grossAmount: 500,
        commissionAmount: 0,
        netAmount: -500,
        idempotencyKey: "withdrawal:wd-1:PAYOUT",
      }),
    });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1" },
      data: { totalWithdrawn: { increment: 500 } },
    });
  });

  it("does not repeat an already completed transition", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue({ id: "wd-1", walletId: "wallet-1", amount: 500, status: "PAID" }),
        updateMany: vi.fn(),
      },
      wallet: { updateMany: vi.fn(), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
      walletTransaction: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(updateWithdrawalWithPrisma(db, { ...input, action: "PAID" })).resolves.toBe(false);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it("uses one D1 batch for rejection and guards dependent writes with changes()", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return { sql, values };
      } }),
      batch: vi.fn().mockResolvedValue(Array.from({ length: 3 }, () => ({ meta: { changes: 1 } }))),
    };
    await expect(updateWithdrawalWithD1(d1 as any, input)).resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(3);
    expect(statements[1].sql).toContain("changes() = 1");
    expect(statements[2].sql).toContain("changes() = 1");
    expect(statements[2].values).toContain("withdrawal:wd-1:REJECT_REFUND");
  });

  it("uses the request amount for D1 payout accounting", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        return { sql, values };
      } }),
      batch: vi.fn().mockResolvedValue(Array.from({ length: 3 }, () => ({ meta: { changes: 1 } }))),
    };
    await expect(updateWithdrawalWithD1(d1 as any, { ...input, action: "PAID" })).resolves.toBe(true);
    expect(statements[2].sql).toContain('SELECT "amount" FROM "WithdrawalRequest"');
    expect(statements[2].sql).toContain('"totalWithdrawn" = "totalWithdrawn" +');
    expect(statements[2].values).toContain("wd-1");
  });

  it("does not apply D1 transitions when the conditional state update loses", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 0 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } },
      ]),
    };
    await expect(updateWithdrawalWithD1(d1 as any, input)).resolves.toBe(false);
  });

  it("propagates D1 batch failures", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("batch aborted")),
    };
    await expect(updateWithdrawalWithD1(d1 as any, input)).rejects.toThrow("batch aborted");
  });
});
