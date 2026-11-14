// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { releaseWalletTransactionWithD1 } from "@/lib/wallet-release-d1";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Wallet" (
      "id" TEXT PRIMARY KEY,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "balance" REAL NOT NULL,
      "pendingBalance" REAL NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "netAmount" REAL NOT NULL,
      "status" TEXT NOT NULL,
      "holdUntil" TEXT,
      "releasedAt" TEXT
    );
    CREATE TABLE "WalletLedger" (
      "id" TEXT PRIMARY KEY,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "type" TEXT NOT NULL,
      "amount" REAL NOT NULL,
      "balanceBefore" REAL NOT NULL,
      "balanceAfter" REAL NOT NULL,
      "referenceType" TEXT,
      "referenceId" TEXT,
      "description" TEXT,
      "idempotencyKey" TEXT UNIQUE,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "WalletReleaseGuard" (
      "id" TEXT PRIMARY KEY,
      "passed" INTEGER NOT NULL,
      "createdAt" TEXT NOT NULL
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
        const results = items.map(({ sql, values }, index) => {
          try {
            const result = sqlite.prepare(sql).run(...(values as never[]));
            return { meta: { changes: Number(result.changes) } };
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`SQLite batch statement ${index + 1}/${items.length} failed: ${sql.trim().replace(/\\s+/g, " ")}; cause: ${detail}`, { cause: error });
          }
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
  sqlite.prepare('INSERT INTO "Wallet" ("id", "financialUnitStatus", "balance", "pendingBalance") VALUES (?, ?, ?, ?)').run("wallet-1", "VERIFIED_IRR", 2000, pendingBalance);
  sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "financialUnitStatus", "walletId", "netAmount", "status", "holdUntil") VALUES (?, ?, ?, ?, ?, ?)').run(
    "txn-1", "VERIFIED_IRR", "wallet-1", 1000, "PENDING", "2026-10-30T09:00:00.000Z"
  );
}

describe("atomic escrow release D1 SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("moves pending funds to available and records one matching RELEASE ledger row", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    const now = new Date("2026-10-30T10:00:00.000Z");
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", now)).toBe(true);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 3000, pendingBalance: 0,
    });
    expect(sqlite.prepare('SELECT "status", "releasedAt" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "AVAILABLE", releasedAt: now.toISOString(),
    });
    expect(sqlite.prepare('SELECT "financialUnitStatus", "type", "amount", "balanceBefore", "balanceAfter", "referenceType", "referenceId", "idempotencyKey" FROM "WalletLedger"').get()).toEqual({
      financialUnitStatus: "VERIFIED_IRR",
      type: "RELEASE",
      amount: 1000,
      balanceBefore: 2000,
      balanceAfter: 3000,
      referenceType: "WalletTransaction",
      referenceId: "txn-1",
      idempotencyKey: "wallet-release:txn-1:LEDGER",
    });
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", now)).toBe(false);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 3000, pendingBalance: 0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletReleaseGuard"').get()).toEqual({ count: 0 });
  });

  it("does not mark the transaction AVAILABLE or write a ledger row when pending balance is insufficient", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite, 200);
    await expect(releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 200,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({ status: "PENDING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletReleaseGuard"').get()).toEqual({ count: 0 });
  });

  it("does not release a transaction whose IRR provenance is unverified", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite);
    sqlite.prepare('INSERT INTO "Wallet" ("id", "financialUnitStatus", "balance", "pendingBalance") VALUES (?, ?, ?, ?)').run("wallet-1", "VERIFIED_IRR", 2000, 1000);
    sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "financialUnitStatus", "walletId", "netAmount", "status", "holdUntil") VALUES (?, ?, ?, ?, ?, ?)').run(
      "txn-unverified", "UNVERIFIED", "wallet-1", 1000, "PENDING", "2026-10-30T09:00:00.000Z"
    );
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-unverified", new Date("2026-10-30T10:00:00.000Z"))).toBe(false);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 2000, pendingBalance: 1000 });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-unverified")).toEqual({ status: "PENDING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("does not release into a wallet whose IRR provenance is unverified", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite);
    sqlite.prepare('INSERT INTO "Wallet" ("id", "financialUnitStatus", "balance", "pendingBalance") VALUES (?, ?, ?, ?)').run("wallet-1", "UNVERIFIED", 2000, 1000);
    sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "financialUnitStatus", "walletId", "netAmount", "status", "holdUntil") VALUES (?, ?, ?, ?, ?, ?)').run(
      "txn-verified", "VERIFIED_IRR", "wallet-1", 1000, "PENDING", "2026-10-30T09:00:00.000Z"
    );
    expect(await releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-verified", new Date("2026-10-30T10:00:00.000Z"))).toBe(false);
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({ balance: 2000, pendingBalance: 1000 });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-verified")).toEqual({ status: "PENDING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back releases for fractional, unsafe, or overflowing source amounts and balances", async () => {
    const cases = [
      {
        name: "fractional net amount",
        sql: 'UPDATE "WalletTransaction" SET "netAmount" = 1000.5 WHERE "id" = ?',
      },
      {
        name: "unsafe net amount",
        sql: 'UPDATE "WalletTransaction" SET "netAmount" = 9007199254740992 WHERE "id" = ?',
      },
      {
        name: "zero net amount",
        sql: 'UPDATE "WalletTransaction" SET "netAmount" = 0 WHERE "id" = ?',
      },
      {
        name: "fractional wallet balance",
        sql: 'UPDATE "Wallet" SET "balance" = 2000.5 WHERE "id" = ?',
      },
      {
        name: "fractional pending balance",
        sql: 'UPDATE "Wallet" SET "pendingBalance" = 1000.5 WHERE "id" = ?',
      },
      {
        name: "negative wallet balance",
        sql: 'UPDATE "Wallet" SET "balance" = -1 WHERE "id" = ?',
      },
      {
        name: "unsafe wallet balance",
        sql: 'UPDATE "Wallet" SET "balance" = 9007199254740992 WHERE "id" = ?',
      },
      {
        name: "unsafe pending balance",
        sql: 'UPDATE "Wallet" SET "pendingBalance" = 9007199254740992 WHERE "id" = ?',
      },
      {
        name: "balance overflow after release",
        sql: 'UPDATE "Wallet" SET "balance" = 9007199254740991 WHERE "id" = ?',
      },
    ];

    for (const scenario of cases) {
      const { sqlite, d1 } = makeD1();
      databases.push(sqlite);
      seed(sqlite);
      if (scenario.name === "balance overflow after release") {
        sqlite.prepare(scenario.sql).run("wallet-1");
      } else {
        sqlite.prepare(scenario.sql).run(scenario.name.includes("net amount") ? "txn-1" : "wallet-1");
      }
      if (scenario.name === "fractional net amount") {
        sqlite.prepare('UPDATE "Wallet" SET "pendingBalance" = 2000 WHERE "id" = ?').run("wallet-1");
      }
      const walletBefore = sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1");

      await expect(
        releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))
      ).rejects.toThrow();

      expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
        .toEqual(walletBefore);
      expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1"))
        .toEqual({ status: "PENDING" });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletReleaseGuard"').get()).toEqual({ count: 0 });
    }
  });

  it("does not release a negative net amount", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite);
    sqlite.prepare('INSERT INTO "Wallet" ("id", "financialUnitStatus", "balance", "pendingBalance") VALUES (?, ?, ?, ?)').run("wallet-1", "VERIFIED_IRR", 2000, 1000);
    sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "financialUnitStatus", "walletId", "netAmount", "status", "holdUntil") VALUES (?, ?, ?, ?, ?, ?)').run(
      "txn-negative", "VERIFIED_IRR", "wallet-1", -100, "PENDING", "2026-10-30T09:00:00.000Z"
    );
    await expect(releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-negative", new Date("2026-10-30T10:00:00.000Z"))).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-negative")).toEqual({
      status: "PENDING",
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back the entire release when the wallet aggregate update silently affects zero rows", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "ignore_wallet_release" BEFORE UPDATE ON "Wallet"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(
      releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "PENDING",
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
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
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back the entire release when the wallet aggregate update silently affects zero rows", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "ignore_wallet_release" BEFORE UPDATE ON "Wallet"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(
      releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "PENDING",
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletReleaseGuard"').get()).toEqual({ count: 0 });
  });

  it("rolls back wallet aggregates when the transaction update silently affects zero rows", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "ignore_release_transition" BEFORE UPDATE ON "WalletTransaction"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(
      releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "PENDING",
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back wallet and transaction changes when the ledger insert silently affects zero rows", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "ignore_release_ledger" BEFORE INSERT ON "WalletLedger"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(
      releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({
      status: "PENDING",
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back the entire release when the RELEASE ledger insert fails", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_release_ledger" BEFORE INSERT ON "WalletLedger"
      BEGIN SELECT RAISE(ABORT, 'ledger insert failed'); END;`);
    await expect(releaseWalletTransactionWithD1(d1 as never, "wallet-1", "txn-1", new Date("2026-10-30T10:00:00.000Z"))).rejects.toThrow("ledger insert failed");
    expect(sqlite.prepare('SELECT "balance", "pendingBalance" FROM "Wallet" WHERE "id" = ?').get("wallet-1")).toEqual({
      balance: 2000, pendingBalance: 1000,
    });
    expect(sqlite.prepare('SELECT "status" FROM "WalletTransaction" WHERE "id" = ?').get("txn-1")).toEqual({ status: "PENDING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });
});
