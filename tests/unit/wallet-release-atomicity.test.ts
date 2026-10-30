// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  releaseWalletTransactionWithD1,
  releaseWalletTransactionWithPrisma,
} from "@/lib/wallet-release";

describe("wallet escrow release atomicity", () => {
  it("uses one Prisma transaction and moves wallet balances only after winning the state transition", async () => {
    const netAmount = 1250;
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const db = {
      $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date())).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", pendingBalance: { gte: netAmount } },
      data: {
        pendingBalance: { decrement: netAmount },
        balance: { increment: netAmount },
      },
    });
  });

  it("does not touch the wallet when another request already transitioned the transaction", async () => {
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount: 1250 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: { updateMany: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<boolean>) => callback(tx)) } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date())).resolves.toBe(false);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it("throws inside the Prisma transaction when pending balance cannot cover the release", async () => {
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount: 1250 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const db = { $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<boolean>) => callback(tx)) } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date()))
      .rejects.toThrow("escrow release rolled back");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("executes the D1 wallet and transaction updates in one batch with guarded transition", async () => {
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          prepared.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]),
    };

    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(2);
    expect(prepared[0].sql).toContain('"pendingBalance"');
    expect(prepared[1].sql).toContain("changes() = 1");
    expect(prepared[0].values).toHaveLength(14);
  });

  it("returns false when the conditional wallet update loses the race", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 0 } }, { meta: { changes: 0 } }]),
    };
    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .resolves.toBe(false);
  });

  it("propagates D1 batch failures so the caller cannot report a successful release", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("D1 batch aborted")),
    };
    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .rejects.toThrow("D1 batch aborted");
  });
});
