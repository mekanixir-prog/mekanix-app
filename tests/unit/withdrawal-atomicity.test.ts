// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createWithdrawalWithD1,
  createWithdrawalWithPrisma,
} from "@/lib/withdrawal-atomic";

const input = {
  walletId: "wallet-1",
  idempotencyKey: "withdrawal-request-0001",
  amount: 500,
  method: "card",
  cardNumber: "****1234",
  bankName: "Test Bank",
  shebaNumber: "IR000000000000000000000000",
  code: "WD-ABC123",
  requestedAt: new Date("2026-10-30T08:00:00.000Z"),
};

describe("atomic withdrawal creation", () => {
  it("debits, creates the request and writes the ledger inside one Prisma transaction", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "wd-1" }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ balance: 1500 }),
      },
      walletLedger: { create: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(createWithdrawalWithPrisma(db, input)).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", balance: { gte: 500 } },
      data: { balance: { decrement: 500 } },
    });
    expect(tx.withdrawalRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idempotencyKey: input.idempotencyKey, amount: 500 }),
    }));
    expect(tx.walletLedger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        amount: -500,
        balanceBefore: 2000,
        balanceAfter: 1500,
        idempotencyKey: "withdrawal:withdrawal-request-0001:LEDGER",
      }),
    }));
  });

  it("does not debit again when the idempotency key already exists", async () => {
    const tx = {
      withdrawalRequest: { findUnique: vi.fn().mockResolvedValue({ id: "wd-existing" }), create: vi.fn() },
      wallet: { updateMany: vi.fn(), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(createWithdrawalWithPrisma(db, input)).resolves.toBe(false);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("does not create a withdrawal when the conditional debit loses the race", async () => {
    const tx = {
      withdrawalRequest: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(createWithdrawalWithPrisma(db, input)).resolves.toBe(false);
    expect(tx.withdrawalRequest.create).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("propagates ledger failures so Prisma rolls back the debit and request", async () => {
    const tx = {
      withdrawalRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "wd-1" }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ balance: 1500 }),
      },
      walletLedger: { create: vi.fn().mockRejectedValue(new Error("ledger failed")) },
    };
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)) } as any;
    await expect(createWithdrawalWithPrisma(db, input)).rejects.toThrow("ledger failed");
  });

  it("uses one D1 batch and guards the debit and ledger with the preceding insert/update", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn().mockResolvedValue(
        Array.from({ length: 3 }, () => ({ meta: { changes: 1 } }))
      ),
    };
    await expect(createWithdrawalWithD1(d1 as any, input)).resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(3);
    expect(statements[0].sql).toContain('ON CONFLICT("idempotencyKey") DO NOTHING');
    expect(statements[1].sql).toContain("changes() = 1");
    expect(statements[2].sql).toContain("changes() = 1");
  });

  it("returns false without partial success when the D1 idempotency gate loses", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
      ]),
    };
    await expect(createWithdrawalWithD1(d1 as any, input)).resolves.toBe(false);
  });

  it("propagates D1 batch errors", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("D1 batch aborted")),
    };
    await expect(createWithdrawalWithD1(d1 as any, input)).rejects.toThrow("D1 batch aborted");
  });
});
