// @vitest-environment node
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { updateWithdrawalWithD1 } from "@/lib/withdrawal-admin-atomic";

type Statement = { sql: string; values: unknown[] };
function makeD1() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Wallet" (
      "id" TEXT PRIMARY KEY,
      "balance" REAL NOT NULL DEFAULT 0,
      "totalWithdrawn" REAL NOT NULL DEFAULT 0,
      "updatedAt" TEXT
    );
    CREATE TABLE "WithdrawalRequest" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "amount" REAL NOT NULL,
      "status" TEXT NOT NULL,
      "reviewerId" TEXT,
      "adminNotes" TEXT,
      "processedAt" TEXT,
      "txnId" TEXT
    );
    CREATE TABLE "WalletLedger" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "type" TEXT NOT NULL,
      "amount" REAL NOT NULL,
      "balanceBefore" REAL NOT NULL,
      "balanceAfter" REAL NOT NULL,
      "referenceType" TEXT,
      "referenceId" TEXT,
      "description" TEXT,
      "idempotencyKey" TEXT UNIQUE,
      "createdBy" TEXT,
      "createdAt" TEXT
    );
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "grossAmount" REAL NOT NULL,
      "commissionAmount" REAL NOT NULL,
      "netAmount" REAL NOT NULL,
      "description" TEXT,
      "idempotencyKey" TEXT UNIQUE,
      "createdAt" TEXT
    );
  `);
  const statements: Statement[] = [];
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    batch(items: Statement[]) {
      statements.push(...items);
      const transaction = sqlite.transaction(() =>
        items.map(({ sql, values }) => {
          const result = sqlite.query(sql).run(...(values as never[]));
          return { meta: { changes: result.changes } };
        })
      );
      return Promise.resolve(transaction());
    },
  };
  return { sqlite, d1, statements };
}

const baseInput = {
  withdrawalId: "wd-1",
  adminId: "admin-1",
  adminNotes: "بررسی شد",
  at: new Date("2026-10-30T10:00:00.000Z"),
};

function seed(sqlite: Database, status: "REQUESTED" | "APPROVED" = "APPROVED") {
  sqlite.query('INSERT INTO "Wallet" ("id", "balance", "totalWithdrawn") VALUES (?, ?, ?)').run("wallet-1", 500, 0);
  sqlite.query('INSERT INTO "WithdrawalRequest" ("id", "walletId", "amount", "status") VALUES (?, ?, ?, ?)').run("wd-1", "wallet-1", 500, status);
}

describe("admin withdrawal D1 SQLite integration", () => {
  const databases: Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("refunds exactly once and writes a matching ledger record on rejection", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    const result = await updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "REJECTED" });
    expect(result).toBe(true);
    expect(sqlite.query('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 1000 });
    expect(sqlite.query('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1")).toEqual({ status: "REJECTED" });
    expect(sqlite.query('SELECT "type", "amount", "balanceBefore", "balanceAfter", "idempotencyKey" FROM "WalletLedger"').get()).toMatchObject({
      type: "REFUND", amount: 500, balanceBefore: 500, balanceAfter: 1000,
      idempotencyKey: "withdrawal:wd-1:REJECT_REFUND",
    });
    expect(await updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "REJECTED" })).toBe(false);
    expect(sqlite.query('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 1000 });
    expect(sqlite.query('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 1 });
  });

  it("records a payout once and increments totalWithdrawn by the exact request amount", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    const result = await updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "PAID" });
    expect(result).toBe(true);
    expect(sqlite.query('SELECT "totalWithdrawn" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ totalWithdrawn: 500 });
    expect(sqlite.query('SELECT "status", "txnId" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1")).toMatchObject({ status: "PAID" });
    expect(sqlite.query('SELECT "kind", "grossAmount", "netAmount", "idempotencyKey" FROM "WalletTransaction"').get()).toMatchObject({
      kind: "PAYOUT", grossAmount: 500, netAmount: -500,
      idempotencyKey: "withdrawal:wd-1:PAYOUT",
    });
    expect(await updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "PAID" })).toBe(false);
    expect(sqlite.query('SELECT "totalWithdrawn" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ totalWithdrawn: 500 });
    expect(sqlite.query('SELECT COUNT(*) AS count FROM "WalletTransaction"').get()).toEqual({ count: 1 });
  });

  it("rolls back the status and wallet credit if the refund ledger insert fails", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite, "REQUESTED");
    sqlite.exec(`CREATE TRIGGER "fail_refund_ledger" BEFORE INSERT ON "WalletLedger"
      BEGIN SELECT RAISE(ABORT, 'ledger write failed'); END;`);
    await expect(updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "REJECTED" })).rejects.toThrow("ledger write failed");
    expect(sqlite.query('SELECT "status" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1")).toEqual({ status: "REQUESTED" });
    expect(sqlite.query('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 500 });
    expect(sqlite.query('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("approves only a REQUESTED request and does not alter wallet balances", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite, "REQUESTED");
    expect(await updateWithdrawalWithD1(d1 as never, { ...baseInput, action: "APPROVED" })).toBe(true);
    expect(sqlite.query('SELECT "status", "reviewerId" FROM "WithdrawalRequest" WHERE "id" = ?').get("wd-1")).toEqual({
      status: "APPROVED", reviewerId: "admin-1",
    });
    expect(sqlite.query('SELECT "balance", "totalWithdrawn" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 500, totalWithdrawn: 0,
    });
  });
});
