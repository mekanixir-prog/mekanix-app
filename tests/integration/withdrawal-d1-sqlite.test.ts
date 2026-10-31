// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createWithdrawalWithD1 } from "@/lib/withdrawal-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Wallet" (
      "id" TEXT PRIMARY KEY,
      "balance" REAL NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "WithdrawalRequest" (
      "id" TEXT PRIMARY KEY,
      "code" TEXT NOT NULL,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "amount" REAL NOT NULL,
      "method" TEXT NOT NULL,
      "cardNumber" TEXT,
      "bankName" TEXT,
      "shebaNumber" TEXT,
      "status" TEXT NOT NULL,
      "idempotencyKey" TEXT UNIQUE,
      "requestedAt" TEXT NOT NULL
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
      "idempotencyKey" TEXT UNIQUE,
      "createdAt" TEXT NOT NULL
    );
  `);
  const d1 = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) { return { sql, values }; } };
    },
    batch(items: Array<{ sql: string; values: unknown[] }>) {
      try {
        sqlite.exec("BEGIN");
        const results = items.map(({ sql, values }) => {
          const result = sqlite.prepare(sql).run(...(values as never[]));
          return { meta: { changes: Number(result.changes) } };
        });
        sqlite.exec("COMMIT");
        return Promise.resolve(results);
      } catch (error) {
        sqlite.exec("ROLLBACK");
        return Promise.reject(error);
      }
    },
  };
  return { sqlite, d1 };
}

function seed(sqlite: DatabaseSync, balance = 1000) {
  sqlite.prepare('INSERT INTO "Wallet" ("id", "balance") VALUES (?, ?)').run("wallet-1", balance);
}

const input = {
  walletId: "wallet-1",
  idempotencyKey: "withdrawal-request-0001",
  amount: 500,
  method: "bank",
  cardNumber: null,
  bankName: "Mellat",
  shebaNumber: "IR000000000000000000000000",
  code: "WD-0001",
  requestedAt: new Date("2026-10-30T10:00:00.000Z"),
};

describe("atomic withdrawal D1 SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("debits the wallet and writes the request plus ledger in one batch", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    expect(await createWithdrawalWithD1(d1 as never, input)).toBe(true);
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 500 });
    expect(sqlite.prepare('SELECT "amount", "status", "idempotencyKey" FROM "WithdrawalRequest"').get()).toEqual({
      amount: 500, status: "REQUESTED", idempotencyKey: input.idempotencyKey,
    });
    expect(sqlite.prepare('SELECT "amount", "balanceBefore", "balanceAfter", "referenceType" FROM "WalletLedger"').get()).toEqual({
      amount: -500, balanceBefore: 1000, balanceAfter: 500, referenceType: "Withdrawal",
    });
  });

  it("does not debit again on a duplicate idempotency key", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    expect(await createWithdrawalWithD1(d1 as never, input)).toBe(true);
    expect(await createWithdrawalWithD1(d1 as never, { ...input, code: "WD-RETRY" })).toBe(false);
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 500 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WithdrawalRequest"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 1 });
  });

  it("creates no request or ledger when balance is insufficient", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite, 100);
    expect(await createWithdrawalWithD1(d1 as never, input)).toBe(false);
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 100 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WithdrawalRequest"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back the debit and request when the ledger insert fails", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_withdrawal_ledger" BEFORE INSERT ON "WalletLedger"
      BEGIN SELECT RAISE(ABORT, 'withdrawal ledger insert failed'); END;`);
    await expect(createWithdrawalWithD1(d1 as never, input)).rejects.toThrow("withdrawal ledger insert failed");
    expect(sqlite.prepare('SELECT "balance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 1000 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WithdrawalRequest"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });
});
