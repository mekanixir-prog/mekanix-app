// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateWithdrawalWithD1 } from "@/lib/withdrawal-admin-atomic";

describe("admin withdrawal D1 transaction integration", () => {
  let sqlite: DatabaseSync;
  let d1: { prepare: (sql: string) => any; batch: (statements: any[]) => Promise<any[]> };

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE "Wallet" (
        "id" TEXT PRIMARY KEY,
        "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
        "balance" REAL NOT NULL,
        "totalWithdrawn" REAL NOT NULL DEFAULT 0,
        "updatedAt" TEXT NOT NULL
      );
      CREATE TABLE "WithdrawalRequest" (
        "id" TEXT PRIMARY KEY,
        "walletId" TEXT NOT NULL,
        "amount" REAL NOT NULL,
        "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
        "status" TEXT NOT NULL,
        "reviewerId" TEXT,
        "adminNotes" TEXT,
        "processedAt" TEXT,
        "txnId" TEXT,
        "idempotencyKey" TEXT
      );
      CREATE TABLE "WalletLedger" (
        "id" TEXT PRIMARY KEY,
        "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
        "type" TEXT NOT NULL,
        "amount" REAL NOT NULL,
        "balanceBefore" REAL NOT NULL,
        "balanceAfter" REAL NOT NULL,
        "referenceType" TEXT NOT NULL,
        "referenceId" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "idempotencyKey" TEXT NOT NULL UNIQUE,
        "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
        "createdBy" TEXT NOT NULL,
        "createdAt" TEXT NOT NULL
      );
      CREATE TABLE "WalletTransaction" (
        "id" TEXT PRIMARY KEY,
        "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
        "kind" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "grossAmount" REAL NOT NULL,
        "commissionAmount" REAL NOT NULL,
        "netAmount" REAL NOT NULL,
        "description" TEXT NOT NULL,
        "idempotencyKey" TEXT NOT NULL UNIQUE,
        "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
        "createdAt" TEXT NOT NULL
      );
      INSERT INTO "Wallet" ("id", "financialUnitStatus", "balance", "totalWithdrawn", "updatedAt")
        VALUES ('wallet-1', 'VERIFIED_IRR', 1000, 0, '2026-10-30T09:00:00.000Z');
      INSERT INTO "WithdrawalRequest" ("id", "walletId", "amount", "financialUnitStatus", "status", "idempotencyKey")
        VALUES ('wd-1', 'wallet-1', 500, 'VERIFIED_IRR', 'REQUESTED', 'wd-key-1');
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdBy", "createdAt")
        VALUES ('wd-ledger-1', 'wallet-1', 'WITHDRAWAL', -500, 1500, 1000,
          'Withdrawal', 'wd-1', 'Withdrawal debit proof', 'withdrawal:wd-key-1:LEDGER',
          'VERIFIED_IRR', 'user-1', '2026-10-30T09:00:00.000Z');
    `);
    d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({ sql, values }),
      }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map(({ sql, values }) => {
            const statement = sqlite.prepare(sql);
            if (/^\s*SELECT/i.test(sql)) {
              statement.get(...values);
              return { meta: { changes: 0 } };
            }
            const result = statement.run(...values);
            return { meta: { changes: Number(result.changes) } };
          });
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
  });

  afterEach(() => sqlite.close());

  it("commits refund, balance update and ledger row together", async () => {
    const result = await updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "REJECTED", adminId: "admin-1",
      adminNotes: "reject", at: new Date("2026-10-30T10:00:00.000Z"),
    });
    expect(result).toBe(true);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "REJECTED" });
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ balance: 1500 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletLedger"').get()).toEqual({ n: 2 });
  });

  it("refuses admin settlement when the original debit ledger proof is missing", async () => {
    sqlite.prepare('DELETE FROM "WalletLedger" WHERE "idempotencyKey" = ?').run("withdrawal:wd-key-1:LEDGER");
    const result = await updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "APPROVED", adminId: "admin-1",
      adminNotes: null, at: new Date("2026-10-30T10:00:00.000Z"),
    });
    expect(result).toBe(false);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "REQUESTED" });
  });

  it("rolls back the status transition when the wallet refund cannot be applied", async () => {
    sqlite.prepare('UPDATE "WithdrawalRequest" SET "walletId" = ? WHERE "id" = ?').run("missing-wallet", "wd-1");
    await expect(updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "REJECTED", adminId: "admin-1",
      adminNotes: null, at: new Date("2026-10-30T10:00:00.000Z"),
    })).resolves.toBe(false);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "REQUESTED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletLedger"').get()).toEqual({ n: 1 });
  });

  it("commits payout state, immutable transaction and wallet aggregate together", async () => {
    sqlite.prepare('UPDATE "WithdrawalRequest" SET "status" = ? WHERE "id" = ?').run("APPROVED", "wd-1");
    const result = await updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "PAID", adminId: "admin-1",
      adminNotes: null, payoutReference: "BANK-TRX-2026-0001",
      at: new Date("2026-10-30T10:00:00.000Z"),
    });
    expect(result).toBe(true);
    expect(sqlite.prepare('SELECT "status", "txnId" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "PAID", txnId: "BANK-TRX-2026-0001" });
    expect(sqlite.prepare('SELECT "totalWithdrawn" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ totalWithdrawn: 500 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletTransaction"').get()).toEqual({ n: 1 });
  });

  it("rolls back rejection when the wallet refund update changes zero rows", async () => {
    sqlite.exec(`CREATE TRIGGER "skip_withdrawal_refund" BEFORE UPDATE OF "balance" ON "Wallet"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "REJECTED", adminId: "admin-1",
      adminNotes: null, at: new Date("2026-10-30T10:00:00.000Z"),
    })).resolves.toBe(false);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "REQUESTED" });
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ balance: 1000 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletLedger"').get()).toEqual({ n: 0 });
  });

  it("rolls back payout state and payout ledger when the wallet aggregate update changes zero rows", async () => {
    sqlite.prepare('UPDATE "WithdrawalRequest" SET "status" = ? WHERE "id" = ?').run("APPROVED", "wd-1");
    sqlite.exec(`CREATE TRIGGER "skip_total_withdrawn" BEFORE UPDATE OF "totalWithdrawn" ON "Wallet"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "PAID", adminId: "admin-1",
      adminNotes: null, payoutReference: "BANK-TRX-2026-0003",
      at: new Date("2026-10-30T10:00:00.000Z"),
    })).resolves.toBe(false);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "APPROVED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletTransaction"').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT "totalWithdrawn" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ totalWithdrawn: 0 });
  });

  it("keeps an approved request unchanged when the verified wallet is missing", async () => {
    sqlite.prepare('UPDATE "WithdrawalRequest" SET "status" = ?, "walletId" = ? WHERE "id" = ?')
      .run("APPROVED", "missing-wallet", "wd-1");
    await expect(updateWithdrawalWithD1(d1 as any, {
      withdrawalId: "wd-1", action: "PAID", adminId: "admin-1",
      adminNotes: null, payoutReference: "BANK-TRX-2026-0002",
      at: new Date("2026-10-30T10:00:00.000Z"),
    })).resolves.toBe(false);
    expect(sqlite.prepare('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1"))
      .toEqual({ status: "APPROVED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "WalletTransaction"').get()).toEqual({ n: 0 });
  });
});
