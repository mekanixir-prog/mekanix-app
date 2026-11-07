// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  JobStatusConflictError,
  transitionJobStatusAtomically,
} from "@/lib/job-status-atomic";
import { addJobPartBeforeInvoice } from "@/lib/job-parts-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "Job" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "requestId" TEXT NOT NULL,
      "technicianId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "updatedAt" TEXT,
      "startedAt" TEXT,
      "arrivedAt" TEXT,
      "completedAt" TEXT,
      "technicianNotes" TEXT,
      "customerApproved" INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE "ServiceRequest" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "status" TEXT NOT NULL,
      "matchedTechId" TEXT,
      "updatedAt" TEXT
    );
    CREATE TABLE "Technician" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "status" TEXT NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "WalletTransaction" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "jobId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "holdUntil" TEXT
    );
    CREATE TABLE "Part" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "jobId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "sku" TEXT,
      "quantity" INTEGER NOT NULL,
      "unitPrice" REAL NOT NULL,
      "financialUnitStatus" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "Invoice" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "code" TEXT NOT NULL UNIQUE,
      "jobId" TEXT NOT NULL UNIQUE,
      "laborHours" REAL NOT NULL,
      "laborRate" REAL NOT NULL,
      "laborTotal" REAL NOT NULL,
      "partsTotal" REAL NOT NULL,
      "travelFee" REAL NOT NULL,
      "inspectionFee" REAL NOT NULL DEFAULT 0,
      "emergencyFee" REAL NOT NULL DEFAULT 0,
      "subtotal" REAL NOT NULL,
      "taxRate" REAL NOT NULL,
      "taxTotal" REAL NOT NULL,
      "discount" REAL NOT NULL,
      "total" REAL NOT NULL,
      "currency" TEXT NOT NULL,
      "pricingVersion" TEXT,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "status" TEXT NOT NULL,
      "notes" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
  `);
  const d1 = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) { return { sql, values }; } };
    },
    batch(items: Array<{ sql: string; values: unknown[] }>) {
      try {
        sqlite.exec("BEGIN IMMEDIATE");
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

const baseInput = {
  jobId: "job-1",
  requestId: "request-1",
  technicianId: "tech-1",
  actorRole: "TECHNICIAN" as const,
  actorTechnicianId: "tech-1",
  currentStatus: "REPAIRING" as const,
  expectedUpdatedAt: new Date("2026-11-02T10:00:00.000Z"),
  nextStatus: "COMPLETED" as const,
  updates: { completedAt: new Date("2026-11-02T10:00:00.000Z") },
};

const invoice = {
  id: "invoice-1",
  code: "INV-123456789ABC",
  jobId: "job-1",
  laborHours: 1,
  laborRate: 18_000_000,
  laborTotal: 18_000_000,
  partsTotal: 10_000_000,
  travelFee: 5_000_000,
  inspectionFee: 6_000_000,
  emergencyFee: 0,
  subtotal: 39_000_000,
  taxRate: 0,
  taxTotal: 0,
  discount: 0,
  total: 39_000_000,
  currency: "IRR",
  pricingVersion: "rate-card-2",
  financialUnitStatus: "VERIFIED_IRR" as const,
  status: "SENT" as const,
  notes: "Fixed-fee rate card rate-card-2; warranty terms follow the approved service agreement.",
};

describe("job status D1 SQLite transaction", () => {
  let sqlite: DatabaseSync;
  let d1: ReturnType<typeof makeD1>["d1"];

  beforeEach(() => {
    const instance = makeD1();
    sqlite = instance.sqlite;
    d1 = instance.d1;
    sqlite.prepare('INSERT INTO "Job" ("id", "requestId", "technicianId", "status", "updatedAt") VALUES (?, ?, ?, ?, ?)')
      .run("job-1", "request-1", "tech-1", "REPAIRING", "2026-11-02T10:00:00.000Z");
    sqlite.prepare('INSERT INTO "ServiceRequest" ("id", "status", "matchedTechId") VALUES (?, ?, ?)')
      .run("request-1", "ASSIGNED", "tech-1");
    sqlite.prepare('INSERT INTO "Technician" ("id", "status") VALUES (?, ?)')
      .run("tech-1", "ON_JOB");
    sqlite.prepare('INSERT INTO "WalletTransaction" ("id", "jobId", "status") VALUES (?, ?, ?)')
      .run("wallet-txn-1", "job-1", "PENDING");
    mocks.getD1Binding.mockResolvedValue(d1);
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  it("commits completion status, 12-hour escrow hold, and technician release together", async () => {
    const holdUntil = new Date("2026-11-02T22:00:00.000Z");
    await expect(transitionJobStatusAtomically({} as any, {
      ...baseInput,
      holdUntil,
    })).resolves.toBeUndefined();

    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "COMPLETED" });
    expect(sqlite.prepare('SELECT "holdUntil" FROM "WalletTransaction" WHERE "id" = ?').get("wallet-txn-1"))
      .toEqual({ holdUntil: holdUntil.toISOString() });
    expect(sqlite.prepare('SELECT "status" FROM "Technician" WHERE "id" = ?').get("tech-1"))
      .toEqual({ status: "ONLINE" });
  });

  it("requires customer approval before a technician can start repair", async () => {
    sqlite.prepare('UPDATE "Job" SET "status" = ?, "customerApproved" = 0 WHERE "id" = ?')
      .run("WAITING_APPROVAL", "job-1");
    const startRepair = {
      ...baseInput,
      currentStatus: "WAITING_APPROVAL" as const,
      nextStatus: "REPAIRING" as const,
      updates: {},
    };

    await expect(transitionJobStatusAtomically({} as any, startRepair))
      .rejects.toBeInstanceOf(JobStatusConflictError);
    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "WAITING_APPROVAL" });

    sqlite.prepare('UPDATE "Job" SET "customerApproved" = 1 WHERE "id" = ?').run("job-1");
    await expect(transitionJobStatusAtomically({} as any, startRepair)).resolves.toBeUndefined();
    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "REPAIRING" });
  });

  it("serializes a D1 part edit against the status transition and prevents a stale invoice", async () => {
    const oldRevision = baseInput.expectedUpdatedAt.toISOString();
    const db = {
      job: {
        findUnique: async () => sqlite.prepare('SELECT "status", "updatedAt" FROM "Job" WHERE "id" = ?').get("job-1"),
      },
      part: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          sqlite.prepare('SELECT * FROM "Part" WHERE "id" = ?').get(where.id),
      },
    } as any;

    const part = await addJobPartBeforeInvoice(db, {
      jobId: "job-1",
      name: "Oil filter",
      sku: "OF-1",
      quantity: 1,
      unitPrice: 1_000_000,
    });
    expect(part).toMatchObject({ jobId: "job-1", financialUnitStatus: "VERIFIED_IRR" });
    const revised = sqlite.prepare('SELECT "updatedAt" FROM "Job" WHERE "id" = ?').get("job-1") as { updatedAt: string };
    expect(new Date(revised.updatedAt).getTime()).toBeGreaterThan(new Date(oldRevision).getTime());

    await expect(transitionJobStatusAtomically(db, {
      ...baseInput,
      invoice,
    })).rejects.toBeInstanceOf(JobStatusConflictError);
    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "REPAIRING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Invoice" WHERE "jobId" = ?').get("job-1"))
      .toEqual({ count: 0 });
  });

  it("rejects a stale job revision when parts changed after the estimate was read", async () => {
    sqlite.prepare('UPDATE "Job" SET "updatedAt" = ? WHERE "id" = ?')
      .run("2026-11-02T10:05:00.000Z", "job-1");

    await expect(transitionJobStatusAtomically({} as any, {
      ...baseInput,
      invoice,
    })).rejects.toBeInstanceOf(JobStatusConflictError);

    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "REPAIRING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Invoice" WHERE "jobId" = ?').get("job-1"))
      .toEqual({ count: 0 });
  });

  it("rolls back job status when the authenticated technician is no longer assigned", async () => {
    sqlite.prepare('UPDATE "Job" SET "technicianId" = ? WHERE "id" = ?').run("tech-2", "job-1");

    await expect(transitionJobStatusAtomically({} as any, baseInput))
      .rejects.toBeInstanceOf(JobStatusConflictError);
    expect(sqlite.prepare('SELECT "status", "technicianId" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "REPAIRING", technicianId: "tech-2" });
    expect(sqlite.prepare('SELECT "holdUntil" FROM "WalletTransaction" WHERE "id" = ?').get("wallet-txn-1"))
      .toEqual({ holdUntil: null });
  });

  it("creates the approval invoice in the same D1 transaction as WAITING_APPROVAL", async () => {
    await expect(transitionJobStatusAtomically({} as any, {
      ...baseInput,
      nextStatus: "WAITING_APPROVAL",
      updates: {},
      invoice,
    })).resolves.toBeUndefined();

    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "WAITING_APPROVAL" });
    expect(sqlite.prepare('SELECT "id", "jobId", "status", "inspectionFee", "emergencyFee", "pricingVersion", "financialUnitStatus" FROM "Invoice" WHERE "jobId" = ?').get("job-1"))
      .toEqual({
        id: "invoice-1",
        jobId: "job-1",
        status: "SENT",
        inspectionFee: 6_000_000,
        emergencyFee: 0,
        pricingVersion: "rate-card-2",
        financialUnitStatus: "VERIFIED_IRR",
      });
  });

  it("rolls back WAITING_APPROVAL when a job invoice already exists", async () => {
    sqlite.prepare(
      'INSERT INTO "Invoice" ("id", "code", "jobId", "laborHours", "laborRate", "laborTotal", "partsTotal", "travelFee", "inspectionFee", "emergencyFee", "subtotal", "taxRate", "taxTotal", "discount", "total", "currency", "pricingVersion", "financialUnitStatus", "status", "notes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      "old-invoice", "INV-OLD", "job-1", 1, 1_500_000, 1_500_000, 0, 3_000_000, 600_000, 0, 5_100_000, 0, 0, 0, 5_100_000, "IRR", "rate-card-1", "VERIFIED_IRR", "SENT", "existing", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z",
    );

    await expect(transitionJobStatusAtomically({} as any, {
      ...baseInput,
      nextStatus: "WAITING_APPROVAL",
      updates: {},
      invoice,
    })).rejects.toBeInstanceOf(JobStatusConflictError);

    expect(sqlite.prepare('SELECT "status" FROM "Job" WHERE "id" = ?').get("job-1"))
      .toEqual({ status: "REPAIRING" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Invoice" WHERE "jobId" = ?').get("job-1"))
      .toEqual({ count: 1 });
  });
});
