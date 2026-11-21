// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  CareExtraApprovalConflictError,
  decideCareExtraApprovalAtomically,
} from "@/lib/care-extra-approval-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "ServiceBooking" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "status" TEXT NOT NULL,
      "updatedAt" TEXT
    );
    CREATE TABLE "Finding" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "bookingId" TEXT NOT NULL,
      "status" TEXT NOT NULL
    );
    CREATE TABLE "CustomerApproval" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "bookingId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "findingId" TEXT,
      "approvedAt" TEXT,
      "rejectedAt" TEXT
    );
    CREATE TABLE "ServiceTimelineEvent" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "bookingId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "timestamp" TEXT NOT NULL,
      "actor" TEXT NOT NULL,
      "metadata" TEXT NOT NULL
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
  sqlite.prepare('INSERT INTO "ServiceBooking" ("id", "status") VALUES (?, ?)').run("booking-1", "WAITING_CUSTOMER_APPROVAL");
  sqlite.prepare('INSERT INTO "Finding" ("id", "bookingId", "status") VALUES (?, ?, ?)')
    .run("finding-1", "booking-1", "PROPOSED");
  sqlite.prepare('INSERT INTO "CustomerApproval" ("id", "bookingId", "status", "findingId") VALUES (?, ?, ?, ?)')
    .run("approval-1", "booking-1", "PROPOSED", "finding-1");
}

const input = {
  bookingId: "booking-1",
  approvalId: "approval-1",
  findingId: "finding-1",
  actorUserId: "customer-user-1",
  decision: "CUSTOMER_APPROVED" as const,
};

describe("CARE extra approval D1 SQLite transaction", () => {
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

  function db() {
    return {
      customerApproval: {
        findUnique: vi.fn(async () =>
          sqlite.prepare('SELECT "id", "status" FROM "CustomerApproval" WHERE "id" = ?').get(input.approvalId)
        ),
      },
    } as any;
  }

  it("commits proposal, booking, finding, and timeline together", async () => {
    await expect(decideCareExtraApprovalAtomically(db(), input))
      .resolves.toMatchObject({ id: input.approvalId, status: "CUSTOMER_APPROVED" });
    expect(sqlite.prepare('SELECT "status" FROM "CustomerApproval" WHERE "id" = ?').get(input.approvalId))
      .toEqual({ status: "CUSTOMER_APPROVED" });
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get(input.bookingId))
      .toEqual({ status: "APPROVED" });
    expect(sqlite.prepare('SELECT "status" FROM "Finding" WHERE "id" = ?').get(input.findingId))
      .toEqual({ status: "APPROVED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 1 });
  });

  it("rolls back the proposal claim when the booking compare-and-set changes zero rows", async () => {
    sqlite.exec(`CREATE TRIGGER "skip_booking_update" BEFORE UPDATE ON "ServiceBooking"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(decideCareExtraApprovalAtomically(db(), input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(sqlite.prepare('SELECT "status" FROM "CustomerApproval" WHERE "id" = ?').get(input.approvalId))
      .toEqual({ status: "PROPOSED" });
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get(input.bookingId))
      .toEqual({ status: "WAITING_CUSTOMER_APPROVAL" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });

  it("rolls back proposal and booking when the finding compare-and-set changes zero rows", async () => {
    sqlite.exec(`CREATE TRIGGER "skip_finding_update" BEFORE UPDATE ON "Finding"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(decideCareExtraApprovalAtomically(db(), input))
      .rejects.toBeInstanceOf(CareExtraApprovalConflictError);
    expect(sqlite.prepare('SELECT "status" FROM "CustomerApproval" WHERE "id" = ?').get(input.approvalId))
      .toEqual({ status: "PROPOSED" });
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get(input.bookingId))
      .toEqual({ status: "WAITING_CUSTOMER_APPROVAL" });
    expect(sqlite.prepare('SELECT "status" FROM "Finding" WHERE "id" = ?').get(input.findingId))
      .toEqual({ status: "PROPOSED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });
});
