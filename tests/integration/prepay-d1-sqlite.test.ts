// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { recordPrepayWithD1 } from "@/lib/prepay-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Job" (
      "id" TEXT PRIMARY KEY,
      "technicianId" TEXT NOT NULL,
      "prepayPaid" INTEGER NOT NULL DEFAULT 0,
      "prepayPaidAt" TEXT,
      "inspectionFee" REAL,
      "travelFee" REAL,
      "platformCommission" REAL,
      "netEarnings" REAL,
      "holdUntil" TEXT,
      "updatedAt" TEXT
    );
    CREATE TABLE "Wallet" (
      "id" TEXT PRIMARY KEY,
      "technicianId" TEXT NOT NULL UNIQUE,
      "pendingBalance" REAL NOT NULL DEFAULT 0,
      "totalEarned" REAL NOT NULL DEFAULT 0,
      "totalCommission" REAL NOT NULL DEFAULT 0,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY,
      "walletId" TEXT NOT NULL REFERENCES "Wallet"("id"),
      "jobId" TEXT NOT NULL REFERENCES "Job"("id"),
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "grossAmount" REAL NOT NULL,
      "commissionAmount" REAL NOT NULL,
      "netAmount" REAL NOT NULL,
      "holdUntil" TEXT,
      "description" TEXT NOT NULL,
      "idempotencyKey" TEXT NOT NULL UNIQUE,
      "createdAt" TEXT NOT NULL
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

function seed(sqlite: DatabaseSync) {
  sqlite.prepare('INSERT INTO "Job" ("id", "technicianId", "prepayPaid") VALUES (?, ?, 0)')
    .run("job-1", "tech-1");
  sqlite.prepare('INSERT INTO "Wallet" ("id", "technicianId", "pendingBalance", "totalEarned", "totalCommission", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run("wallet-1", "tech-1", 100, 0, 0, "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z");
}

const input = {
  jobId: "job-1",
  jobCode: "JOB-001",
  technicianId: "tech-1",
  gross: 1000,
  commission: 100,
  net: 900,
  inspectionFee: 700,
  travelFee: 300,
  paidAt: new Date("2026-10-30T10:00:00.000Z"),
  machineLabel: "heavy" as const,
};

describe("atomic prepay D1 SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  it("commits the job marker, both transactions, both ledger rows and wallet aggregates together", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    expect(await recordPrepayWithD1(d1 as never, input)).toBe(true);
    expect(sqlite.prepare('SELECT "prepayPaid", "inspectionFee", "travelFee", "platformCommission", "netEarnings" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ prepayPaid: 1, inspectionFee: 700, travelFee: 300, platformCommission: 100, netEarnings: 900 });
    expect(sqlite.prepare('SELECT "pendingBalance", "totalEarned", "totalCommission" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ pendingBalance: 1000, totalEarned: 1000, totalCommission: 100 });
    expect(sqlite.prepare('SELECT "kind", "status", "netAmount" FROM "WalletTransaction" ORDER BY "kind"').all())
      .toEqual([{ kind: "COMMISSION", status: "COMPLETED", netAmount: -100 }, { kind: "PREPAY", status: "PENDING", netAmount: 900 }]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 2 });
  });

  it("does not apply the financial writes again on a retry after a completed prepay", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    expect(await recordPrepayWithD1(d1 as never, input)).toBe(true);
    const retry = { ...input, paidAt: new Date("2026-10-30T10:01:00.000Z") };
    expect(await recordPrepayWithD1(d1 as never, retry)).toBe(false);
    expect(sqlite.prepare('SELECT "pendingBalance", "totalEarned", "totalCommission" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ pendingBalance: 1000, totalEarned: 1000, totalCommission: 100 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletTransaction"').get()).toEqual({ count: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 2 });
  });

  it("rolls back the job marker and wallet aggregates on a deterministic key collision", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "walletId", "jobId", "kind", "status", "grossAmount", "commissionAmount", "netAmount", "description", "idempotencyKey", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run("existing-txn", "wallet-1", "job-1", "PREPAY", "PENDING", 1000, 100, 900, "legacy", "prepay:job-1:PREPAY", "2026-10-30T09:00:00.000Z");
    await expect(recordPrepayWithD1(d1 as never, input)).rejects.toThrow();
    expect(sqlite.prepare('SELECT "prepayPaid" FROM "Job" WHERE "id" = ?').get("job-1")).toEqual({ prepayPaid: 0 });
    expect(sqlite.prepare('SELECT "pendingBalance", "totalEarned", "totalCommission" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ pendingBalance: 100, totalEarned: 0, totalCommission: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletTransaction"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });

  it("rolls back all financial writes when the final commission ledger insert fails", async () => {
    const { sqlite, d1 } = makeD1(); databases.push(sqlite); seed(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_commission_ledger" BEFORE INSERT ON "WalletLedger"
      WHEN NEW."type" = 'COMMISSION'
      BEGIN SELECT RAISE(ABORT, 'commission ledger insert failed'); END;`);
    await expect(recordPrepayWithD1(d1 as never, input)).rejects.toThrow("commission ledger insert failed");
    expect(sqlite.prepare('SELECT "prepayPaid" FROM "Job" WHERE "id" = ?').get("job-1")).toEqual({ prepayPaid: 0 });
    expect(sqlite.prepare('SELECT "pendingBalance", "totalEarned", "totalCommission" FROM "Wallet" WHERE "id" = ?').get("wallet-1"))
      .toEqual({ pendingBalance: 100, totalEarned: 0, totalCommission: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletTransaction"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "WalletLedger"').get()).toEqual({ count: 0 });
  });
});
