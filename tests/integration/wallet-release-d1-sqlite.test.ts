// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWalletTransactionWithD1 } from "@/lib/wallet-release";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Wallet" (
      "id" TEXT PRIMARY KEY,
      "balance" REAL NOT NULL,
      "pendingBalance" REAL NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "netAmount" REAL NOT NULL,
      "status" TEXT NOT NULL,
      "holdUntil" TEXT,
      "releasedAt" TEXT
    );
  `);
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
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

function seed(sqlite: DatabaseSync, pendingBalance = 1000) {
  sqlite.prepare('INSERT INTO "Wallet" ("id", "balance", "pendingBalance") VALUES (?, ?, ?)').run("wallet-1", 2000, pendingBalance);
  sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "walletId", "netAmount", "status", "holdUntil") VALUES (?, ?, ?, ?, ?)').run(
    "txn-1", "wallet-1", 1000, "PENDING", "2026-10-30T09:00:00.000Z"
  );
}

describe("atomic escrow release D1 SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("moves pending funds to available exactly once", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    const now = new Date("2026-10-30T10:00:00.000Z");
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", now)).toBe(true);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 3000, pendingBalance: 0,
    });
    expect(sqlite.prepare('SELECT "status", "releasedAt" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "AVAILABLE", releasedAt: now.toISOString(),
    });
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", now)).toBe(false);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 3000, pendingBalance: 0,
    });
  });

  it("does not mark the transaction AVAILABLE when pending balance is insufficient", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite, 200);
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))).toBe(false);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 200,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({ status: "PENDING" });
  });

  it("rolls back wallet aggregates if the transaction status update fails", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_release" BEFORE UPDATE ON "WalletTransaction"
      BEGIN SELECT RAISE(ABORT, 'transaction status write failed'); END;`);
    await expect(releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))).rejects.toThrow("transaction status write failed");
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({ status: "PENDING" });
  });
});
