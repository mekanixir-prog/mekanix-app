// @vitest-environment node
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  releaseWalletTransactionWithD1,
  releaseWalletTransactionWithPrisma,
} from "@/lib/wallet-release";

describe("wallet escrow release atomicity", () => {
  it("moves wallet balances and writes the matching RELEASE ledger proof in one Prisma transaction", async () => {
    const netAmount = 1250;
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount, financialUnitStatus: "VERIFIED_IRR" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ balance: new Prisma.Decimal(3250), pendingBalance: new Prisma.Decimal(0), financialUnitStatus: "VERIFIED_IRR" }),
      },
      walletLedger: { create: vi.fn().mockResolvedValue({ id: "ledger-1" }) },
    };
    const db = {
      $transaction: vi.fn(async (callback: (tx: any) => Promise<boolean>) => callback(tx)),
    } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date())).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.walletTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ netAmount: { gte: 0 } }),
    }));
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ netAmount: { gte: 0 } }),
    }));
    expect(tx.walletTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: "wallet-1", financialUnitStatus: "VERIFIED_IRR", balance: { gte: 0 }, pendingBalance: { gte: netAmount } },
      data: {
        pendingBalance: { decrement: netAmount },
        balance: { increment: netAmount },
      },
    });
    expect(tx.walletLedger.create).toHaveBeenCalledTimes(1);
    const ledgerData = tx.walletLedger.create.mock.calls[0][0].data;
    expect(ledgerData).toMatchObject({
      walletId: "wallet-1",
      type: "RELEASE",
      referenceType: "WalletTransaction",
      referenceId: "txn-1",
      idempotencyKey: "wallet-release:txn-1:LEDGER",
    });
    expect(Number(ledgerData.amount)).toBe(netAmount);
    expect(Number(ledgerData.balanceBefore)).toBe(2000);
    expect(Number(ledgerData.balanceAfter)).toBe(3250);
  });

  it("does not touch the wallet or ledger when another request already transitioned the transaction", async () => {
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount: 1250, financialUnitStatus: "VERIFIED_IRR" }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: { updateMany: vi.fn(), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (tx: any) => Promise<boolean>) => callback(tx)) } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date())).resolves.toBe(false);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("throws inside the Prisma transaction when pending balance cannot cover the release", async () => {
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue({ netAmount: 1250, financialUnitStatus: "VERIFIED_IRR" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      wallet: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (tx: any) => Promise<boolean>) => callback(tx)) } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-1", new Date()))
      .rejects.toThrow("escrow release rolled back");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

  it("executes the current-main wallet, transaction, ledger, and rollback guard writes in one D1 batch", async () => {
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          prepared.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    };

    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .resolves.toBe(true);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    const statements = d1.batch.mock.calls[0][0] as Array<{ sql: string; values: unknown[] }>;
    expect(statements).toHaveLength(5);
    expect(statements[0].sql).toContain('INSERT INTO "WalletLedger"');
    expect(statements[0].sql).toContain("'RELEASE'");
    expect(statements[0].sql).toContain('"balanceBefore"');
    expect(statements[0].sql).toContain('"balanceAfter"');
    expect(statements[1].sql).toContain('"pendingBalance"');
    expect(statements[1].sql).toContain('"balanceBefore" = w."balance"');
    expect(statements[2].sql).toContain('"status" = \'PENDING\'');
    expect(statements[2].sql).toContain('"balance" = ledger."balanceAfter"');
    expect(statements[3].sql).toContain('INSERT INTO "WalletReleaseGuard"');
    expect(statements[3].sql).toContain('ELSE NULL');
    expect(statements[4].sql).toContain('DELETE FROM "WalletReleaseGuard"');
    expect(statements.every((statement) => !statement.sql.includes("changes()"))).toBe(true);
    expect(statements[0].values).toContain("wallet-release:txn-1:LEDGER");
  });

  it("returns false when the conditional wallet update loses the race", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    };
    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .resolves.toBe(false);
  });

  it("propagates a ledger failure so the D1 batch rolls back the entire release", async () => {
    const d1 = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: vi.fn().mockRejectedValue(new Error("unique RELEASE ledger key conflict")),
    };
    await expect(releaseWalletTransactionWithD1(d1 as any, "wallet-1", "txn-1", new Date()))
      .rejects.toThrow("unique RELEASE ledger key conflict");
  });

  it("does not release a transaction without verified IRR provenance", async () => {
    const tx = {
      walletTransaction: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn(),
      },
      wallet: { updateMany: vi.fn(), findUnique: vi.fn() },
      walletLedger: { create: vi.fn() },
    };
    const db = { $transaction: vi.fn(async (callback: (tx: any) => Promise<boolean>) => callback(tx)) } as any;

    await expect(releaseWalletTransactionWithPrisma(db, "wallet-1", "txn-unverified", new Date())).resolves.toBe(false);
    expect(tx.walletTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ financialUnitStatus: "VERIFIED_IRR" }),
    }));
    expect(tx.walletTransaction.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.walletLedger.create).not.toHaveBeenCalled();
  });

});
