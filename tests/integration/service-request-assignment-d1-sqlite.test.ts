// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  assignServiceRequestAtomically,
  ServiceRequestAssignmentConflictError,
} from "@/lib/service-request-assignment";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "ServiceRequest" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "status" TEXT NOT NULL,
      "matchedTechId" TEXT,
      "updatedAt" TEXT
    );
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "status" TEXT NOT NULL,
      "role" TEXT NOT NULL
    );
    CREATE TABLE "Technician" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "userId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "verified" INTEGER NOT NULL,
      "availableNow" INTEGER NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "TechnicianSpecialty" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "technicianId" TEXT NOT NULL,
      "category" TEXT NOT NULL
    );
    CREATE TABLE "Job" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "code" TEXT NOT NULL UNIQUE,
      "requestId" TEXT NOT NULL UNIQUE,
      "technicianId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "etaMins" INTEGER NOT NULL,
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

function seed(sqlite: DatabaseSync) {
  sqlite.prepare('INSERT INTO "ServiceRequest" ("id", "status") VALUES (?, ?)').run("request-1", "OPEN");
  sqlite.prepare('INSERT INTO "User" ("id", "status", "role") VALUES (?, ?, ?)').run("user-1", "ACTIVE", "TECHNICIAN");
  sqlite.prepare('INSERT INTO "Technician" ("id", "userId", "status", "verified", "availableNow") VALUES (?, ?, ?, ?, ?)')
    .run("technician-1", "user-1", "ONLINE", 1, 1);
  sqlite.prepare('INSERT INTO "TechnicianSpecialty" ("id", "technicianId", "category") VALUES (?, ?, ?)')
    .run("specialty-1", "technician-1", "hydraulic");
}

const input = {
  requestId: "request-1",
  technicianId: "technician-1",
  category: "hydraulic",
  etaMins: 24,
  existingRejectedJobId: null,
};

describe("service-request assignment D1 SQLite transaction", () => {
  let sqlite: DatabaseSync;
  let d1: ReturnType<typeof makeD1>["d1"];

  beforeEach(() => {
    const instance = makeD1();
    sqlite = instance.sqlite;
    d1 = instance.d1;
    seed(sqlite);
    mocks.getD1Binding.mockResolvedValue(d1);
  });
  afterEach(() => { sqlite.close(); vi.clearAllMocks(); });

  it("commits the request claim, technician claim, and job together", async () => {
    const db = {
      job: {
        findUnique: vi.fn(async () =>
          sqlite.prepare('SELECT "id" FROM "Job" WHERE "requestId" = ?').get(input.requestId)
        ),
      },
    } as any;
    await expect(assignServiceRequestAtomically(db, input)).resolves.toBeUndefined();
    expect(sqlite.prepare('SELECT "status", "matchedTechId" FROM "ServiceRequest" WHERE "id" = ?').get(input.requestId))
      .toEqual({ status: "ASSIGNED", matchedTechId: input.technicianId });
    expect(sqlite.prepare('SELECT "status" FROM "Technician" WHERE "id" = ?').get(input.technicianId))
      .toEqual({ status: "ON_JOB" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Job"').get()).toEqual({ count: 1 });
  });

  it("rolls back the request claim when the technician compare-and-set changes zero rows", async () => {
    sqlite.exec(`CREATE TRIGGER "skip_technician_claim" BEFORE UPDATE ON "Technician"
      BEGIN SELECT RAISE(IGNORE); END;`);
    const db = { job: { findUnique: vi.fn() } } as any;
    await expect(assignServiceRequestAtomically(db, input))
      .rejects.toBeInstanceOf(ServiceRequestAssignmentConflictError);
    expect(sqlite.prepare('SELECT "status", "matchedTechId" FROM "ServiceRequest" WHERE "id" = ?').get(input.requestId))
      .toEqual({ status: "OPEN", matchedTechId: null });
    expect(sqlite.prepare('SELECT "status" FROM "Technician" WHERE "id" = ?').get(input.technicianId))
      .toEqual({ status: "ONLINE" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Job"').get()).toEqual({ count: 0 });
  });

  it("rolls back both claims when job creation changes zero rows", async () => {
    sqlite.exec(`CREATE TRIGGER "skip_job_insert" BEFORE INSERT ON "Job"
      BEGIN SELECT RAISE(IGNORE); END;`);
    const db = { job: { findUnique: vi.fn() } } as any;
    await expect(assignServiceRequestAtomically(db, input))
      .rejects.toBeInstanceOf(ServiceRequestAssignmentConflictError);
    expect(sqlite.prepare('SELECT "status", "matchedTechId" FROM "ServiceRequest" WHERE "id" = ?').get(input.requestId))
      .toEqual({ status: "OPEN", matchedTechId: null });
    expect(sqlite.prepare('SELECT "status" FROM "Technician" WHERE "id" = ?').get(input.technicianId))
      .toEqual({ status: "ONLINE" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Job"').get()).toEqual({ count: 0 });
  });
});
