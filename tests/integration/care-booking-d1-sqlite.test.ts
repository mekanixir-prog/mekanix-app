// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

import {
  CareBookingIdempotencyConflict,
  createCareBookingAtomically,
} from "@/lib/care-booking-atomic";

const input = {
  idempotencyKey: "care-booking:user-1:integration-001",
  requestFingerprint: '{"userId":"user-1","vehicleId":"vehicle-1"}',
  code: "CARE-INTEGRATION-001",
  userId: "user-1",
  vehicleId: "vehicle-1",
  packageId: null,
  serviceType: "periodic",
  location: "Tehran",
  lat: 35.7,
  lng: 51.4,
  date: null,
  timeWindow: "09:00-11:00",
  currentMileage: 12000,
  pricing: {
    labor: 50000,
    travel: 15000,
    inspection: 0,
    parts: 0,
    discount: 0,
    taxRate: 0.09,
    taxTotal: 5850,
    total: 70850,
    currency: "IRR",
    pricingVersion: "2.1",
  },
};

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "ServiceBooking" (
      "id" TEXT PRIMARY KEY,
      "code" TEXT NOT NULL UNIQUE,
      "userId" TEXT NOT NULL,
      "vehicleId" TEXT NOT NULL,
      "packageId" TEXT,
      "serviceType" TEXT NOT NULL,
      "location" TEXT NOT NULL,
      "lat" REAL,
      "lng" REAL,
      "date" TEXT,
      "timeWindow" TEXT,
      "currentMileage" INTEGER,
      "status" TEXT NOT NULL,
      "idempotencyKey" TEXT UNIQUE,
      "requestFingerprint" TEXT,
      "pricingSnapshotId" TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "PricingSnapshot" (
      "id" TEXT PRIMARY KEY,
      "bookingId" TEXT UNIQUE,
      "servicePrice" REAL NOT NULL,
      "visitPrice" REAL NOT NULL,
      "inspectionPrice" REAL NOT NULL,
      "laborPrice" REAL NOT NULL,
      "partsPrice" REAL NOT NULL,
      "discount" REAL NOT NULL,
      "taxRate" REAL NOT NULL,
      "taxTotal" REAL NOT NULL,
      "total" REAL NOT NULL,
      "currency" TEXT NOT NULL,
      "pricingVersion" TEXT NOT NULL,
      "financialUnitStatus" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL,
      FOREIGN KEY ("bookingId") REFERENCES "ServiceBooking"("id")
    );
    CREATE TABLE "ServiceTimelineEvent" (
      "id" TEXT PRIMARY KEY,
      "bookingId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "timestamp" TEXT NOT NULL,
      "actor" TEXT,
      "idempotencyKey" TEXT UNIQUE,
      FOREIGN KEY ("bookingId") REFERENCES "ServiceBooking"("id")
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
    async batch(statements: Array<{ sql: string; values: unknown[] }>) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }) => {
          const result = sqlite.prepare(sql).run(...(values as never[]));
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

function makeDb(sqlite: DatabaseSync) {
  return {
    serviceBooking: {
      findUnique: async ({ where }: any) =>
        sqlite.prepare(`
          SELECT "id", "requestFingerprint", "pricingSnapshotId"
          FROM "ServiceBooking" WHERE "idempotencyKey" = ?
        `).get(where.idempotencyKey) ?? null,
    },
  } as any;
}

describe("CARE D1 booking atomicity — SQLite integration", () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    for (const database of databases.splice(0)) database.close();
  });

  it("creates booking, pricing snapshot, link, and timeline event exactly once under 100 concurrent retries", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });
    const db = makeDb(sqlite);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => createCareBookingAtomically(db, input))
    );

    expect(new Set(results.map((booking) => booking.id)).size).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceBooking"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "PricingSnapshot"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT "pricingSnapshotId" FROM "ServiceBooking"').get()).toEqual({
      pricingSnapshotId: sqlite.prepare('SELECT "id" FROM "PricingSnapshot"').get()?.id,
    });
  });

  it("replays an identical request and rejects same-key payload mismatch", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });
    const db = makeDb(sqlite);

    const first = await createCareBookingAtomically(db, input);
    const replay = await createCareBookingAtomically(db, input);
    await expect(createCareBookingAtomically(db, {
      ...input,
      requestFingerprint: '{"userId":"user-1","vehicleId":"vehicle-2"}',
    })).rejects.toBeInstanceOf(CareBookingIdempotencyConflict);

    expect(first.id).toBe(replay.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceBooking"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "PricingSnapshot"').get()).toEqual({ count: 1 });
  });

  it("rolls back the booking when the pricing snapshot insert fails", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_pricing_snapshot" BEFORE INSERT ON "PricingSnapshot"
      BEGIN SELECT RAISE(ABORT, 'pricing snapshot failed'); END;`);
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });

    await expect(createCareBookingAtomically(makeDb(sqlite), input))
      .rejects.toThrow("pricing snapshot failed");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceBooking"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "PricingSnapshot"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });

  it("rolls back booking and pricing when the snapshot-link update fails", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_snapshot_link" BEFORE UPDATE OF "pricingSnapshotId" ON "ServiceBooking"
      BEGIN SELECT RAISE(ABORT, 'snapshot link failed'); END;`);
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });

    await expect(createCareBookingAtomically(makeDb(sqlite), input))
      .rejects.toThrow("snapshot link failed");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceBooking"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "PricingSnapshot"').get()).toEqual({ count: 0 });
  });

  it("rolls back booking, pricing, and link when the timeline insert fails", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_timeline" BEFORE INSERT ON "ServiceTimelineEvent"
      BEGIN SELECT RAISE(ABORT, 'timeline event failed'); END;`);
    mocks.getCloudflareContext.mockResolvedValue({ env: { DB: d1 } });

    await expect(createCareBookingAtomically(makeDb(sqlite), input))
      .rejects.toThrow("timeline event failed");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceBooking"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "PricingSnapshot"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });
});
