// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

import { recordCareStatusTransition } from "@/lib/care-status-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "ServiceBooking" (
      "id" TEXT PRIMARY KEY,
      "status" TEXT NOT NULL,
      "technicianId" TEXT,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "ServiceTimelineEvent" (
      "id" TEXT PRIMARY KEY,
      "bookingId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "timestamp" TEXT NOT NULL,
      "actor" TEXT,
      "idempotencyKey" TEXT UNIQUE
    );
    INSERT INTO "ServiceBooking" ("id", "status", "technicianId", "updatedAt")
    VALUES ('mission-1', 'ASSIGNED', 'tech-1', '2026-11-26T10:00:00.000Z');
  `);

  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { sql, values };
        },
      };
    },
    async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(({ sql, values }) => {
          const statement = sqlite.prepare(sql);
          if (/^\\s*SELECT/i.test(sql)) {
            return { meta: { changes: 0 }, result: statement.get(...(values as never[])) };
          }
          const result = statement.run(...(values as never[]));
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
  return { sqlite, d1 };
}

describe("CARE status transition D1 atomicity — SQLite integration", () => {
  let sqlite: DatabaseSync;
  let d1: ReturnType<typeof makeD1>["d1"];

  beforeEach(() => {
    ({ sqlite, d1 } = makeD1());
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    sqlite.close();
  });

  const transition = () => recordCareStatusTransition({
    serviceBooking: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        sqlite.prepare('SELECT * FROM "ServiceBooking" WHERE "id" = ?').get(where.id),
    },
  } as never, {
    bookingId: "mission-1",
    expectedStatus: "ASSIGNED",
    expectedUpdatedAt: new Date("2026-11-26T10:00:00.000Z"),
    nextStatus: "EN_ROUTE",
    technicianId: "tech-1",
    actorId: "user-tech-1",
  });

  it("commits the status and exactly one matching timeline event in one D1 batch", async () => {
    await transition();
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get("mission-1"))
      .toEqual({ status: "EN_ROUTE" });
    expect(sqlite.prepare('SELECT "eventType", "actor" FROM "ServiceTimelineEvent"').all())
      .toEqual([{ eventType: "en_route", actor: "user-tech-1" }]);
  });

  it("rolls back the status when the timeline insert fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER "fail_status_timeline" BEFORE INSERT ON "ServiceTimelineEvent"
      BEGIN SELECT RAISE(ABORT, 'injected status timeline failure'); END;
    `);
    await expect(transition()).rejects.toThrow("injected status timeline failure");
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get("mission-1"))
      .toEqual({ status: "ASSIGNED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get())
      .toEqual({ count: 0 });
  });

  it("rejects a stale expected status without leaving a timeline row", async () => {
    sqlite.prepare('UPDATE "ServiceBooking" SET "status" = ? WHERE "id" = ?')
      .run("ARRIVED", "mission-1");
    await expect(transition()).rejects.toThrow(/malformed JSON/i);
    expect(sqlite.prepare('SELECT "status" FROM "ServiceBooking" WHERE "id" = ?').get("mission-1"))
      .toEqual({ status: "ARRIVED" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get())
      .toEqual({ count: 0 });
  });
});
