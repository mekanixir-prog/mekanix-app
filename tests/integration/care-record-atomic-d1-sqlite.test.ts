// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  CareRecordConflictError,
  CareRecordIdempotencyConflictError,
  createCareFindingAtomically,
  upsertCareHealthReportAtomically,
  upsertCareInspectionAtomically,
} from "@/lib/care-record-atomic";

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE "ServiceBooking" (
      "id" TEXT PRIMARY KEY, "vehicleId" TEXT NOT NULL,
      "technicianId" TEXT, "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "Finding" (
      "id" TEXT PRIMARY KEY, "bookingId" TEXT NOT NULL, "category" TEXT NOT NULL,
      "title" TEXT NOT NULL, "description" TEXT, "severity" TEXT NOT NULL,
      "evidence" TEXT, "recommendedAction" TEXT, "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "ServiceTimelineEvent" (
      "id" TEXT PRIMARY KEY, "bookingId" TEXT NOT NULL, "eventType" TEXT NOT NULL,
      "timestamp" TEXT NOT NULL, "actor" TEXT, "metadata" TEXT,
      "idempotencyKey" TEXT UNIQUE
    );
    CREATE TABLE "Inspection" (
      "id" TEXT PRIMARY KEY, "bookingId" TEXT NOT NULL UNIQUE,
      "checklistVersion" TEXT NOT NULL, "results" TEXT NOT NULL,
      "measurements" TEXT, "images" TEXT, "technicianNotes" TEXT,
      "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "VehicleHealthReport" (
      "id" TEXT PRIMARY KEY, "vehicleId" TEXT NOT NULL, "bookingId" TEXT UNIQUE,
      "overallScore" REAL NOT NULL, "engineScore" REAL, "oilScore" REAL,
      "brakeScore" REAL, "batteryScore" REAL, "tireScore" REAL,
      "filterScore" REAL, "fluidScore" REAL, "coolingScore" REAL,
      "beltScore" REAL, "leakScore" REAL, "diagnosticScore" REAL,
      "categories" TEXT, "evidence" TEXT, "technicianId" TEXT, "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "VehicleCareProfile" (
      "id" TEXT PRIMARY KEY, "vehicleId" TEXT NOT NULL UNIQUE,
      "healthScore" REAL NOT NULL, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
    );
    INSERT INTO "ServiceBooking" ("id", "vehicleId", "technicianId", "updatedAt")
    VALUES ('booking-1', 'vehicle-1', 'technician-1', '2026-11-26T10:00:00.000Z');
  `);

  let queue = Promise.resolve();
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) { return { sql, values }; },
      };
    },
    batch(statements: Array<{ sql: string; values: unknown[] }>) {
      const run = async () => {
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
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };

  return { sqlite, d1 };
}

const actor = {
  bookingId: "booking-1",
  actorRole: "TECHNICIAN" as const,
  actorUserId: "user-tech-1",
  actorTechnicianId: "technician-1",
  idempotencyKey: "care-record-test-key",
  requestFingerprint: "sha256:care-record-test-fingerprint",
};

const findingInput = {
  ...actor,
  category: "engine",
  title: "Oil leak",
  description: "Leak near filter",
  severity: "HIGH",
  evidence: JSON.stringify({ images: [] }),
  recommendedAction: "Replace seal",
};

const inspectionInput = {
  ...actor,
  results: JSON.stringify({ engine: { oil: "PASS" } }),
  measurements: JSON.stringify({ voltage: "12.4V" }),
  images: JSON.stringify([]),
  technicianNotes: "Checked",
};

const healthInput = {
  ...actor,
  overallScore: 87,
  engineScore: 90,
  oilScore: 85,
  brakeScore: null,
  batteryScore: null,
  tireScore: null,
  filterScore: null,
  fluidScore: null,
  coolingScore: null,
  beltScore: null,
  leakScore: null,
  diagnosticScore: null,
  categories: JSON.stringify({ engine: 90 }),
  evidence: JSON.stringify({}),
};

describe("CARE record D1 atomicity — SQLite integration", () => {
  let sqlite: DatabaseSync;
  let d1: ReturnType<typeof makeD1>["d1"];
  const db = {
    serviceBooking: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        sqlite.prepare('SELECT * FROM "ServiceBooking" WHERE "id" = ?').get(where.id)),
    },
    finding: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        sqlite.prepare('SELECT * FROM "Finding" WHERE "id" = ?').get(where.id)),
    },
    inspection: {
      findUnique: vi.fn(async ({ where }: { where: { bookingId: string } }) =>
        sqlite.prepare('SELECT * FROM "Inspection" WHERE "bookingId" = ?').get(where.bookingId)),
    },
    vehicleHealthReport: {
      findUnique: vi.fn(async ({ where }: { where: { bookingId: string } }) =>
        sqlite.prepare('SELECT * FROM "VehicleHealthReport" WHERE "bookingId" = ?').get(where.bookingId)),
    },
    serviceTimelineEvent: {
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        sqlite.prepare('SELECT * FROM "ServiceTimelineEvent" WHERE "idempotencyKey" = ?').get(where.idempotencyKey)),
    },
  } as any;

  beforeEach(() => {
    ({ sqlite, d1 } = makeD1());
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    mocks.getD1Binding.mockResolvedValue(d1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    sqlite.close();
  });

  it("commits finding and timeline together", async () => {
    const finding = await createCareFindingAtomically(db, findingInput);
    expect(finding.title).toBe("Oil leak");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Finding"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT "eventType" FROM "ServiceTimelineEvent"').all())
      .toEqual([{ eventType: "extra_proposal" }]);
  });

  it("rolls back the booking claim and finding when timeline insertion fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER "fail_finding_timeline" BEFORE INSERT ON "ServiceTimelineEvent"
      BEGIN SELECT RAISE(ABORT, 'injected finding timeline failure'); END;
    `);
    await expect(createCareFindingAtomically(db, findingInput))
      .rejects.toThrow("injected finding timeline failure");
    expect(sqlite.prepare('SELECT "updatedAt" FROM "ServiceBooking" WHERE "id" = ?').get("booking-1"))
      .toEqual({ updatedAt: "2026-11-26T10:00:00.000Z" });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Finding"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });

  it("fails closed when the assigned technician changed", async () => {
    sqlite.prepare('UPDATE "ServiceBooking" SET "technicianId" = ? WHERE "id" = ?')
      .run("other-technician", "booking-1");
    await expect(createCareFindingAtomically(db, findingInput)).rejects.toBeInstanceOf(CareRecordConflictError);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Finding"').get()).toEqual({ count: 0 });
  });

  it("deduplicates concurrent and sequential finding replays by idempotency key", async () => {
    const outcomes = await Promise.allSettled([
      createCareFindingAtomically(db, findingInput),
      createCareFindingAtomically(db, findingInput),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await createCareFindingAtomically(db, findingInput);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Finding"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 1 });
  });
  it("rejects reusing a finding idempotency key with a different payload fingerprint", async () => {
    await createCareFindingAtomically(db, findingInput);
    await expect(createCareFindingAtomically(db, {
      ...findingInput,
      requestFingerprint: "sha256:different-payload",
    })).rejects.toBeInstanceOf(CareRecordIdempotencyConflictError);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Finding"').get()).toEqual({ count: 1 });
  });


  it("rolls back inspection upsert when its timeline insert fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER "fail_inspection_timeline" BEFORE INSERT ON "ServiceTimelineEvent"
      BEGIN SELECT RAISE(ABORT, 'injected inspection timeline failure'); END;
    `);
    await expect(upsertCareInspectionAtomically(db, inspectionInput))
      .rejects.toThrow("injected inspection timeline failure");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Inspection"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });

  it("deduplicates concurrent and sequential inspection replays by idempotency key", async () => {
    const outcomes = await Promise.allSettled([
      upsertCareInspectionAtomically(db, inspectionInput),
      upsertCareInspectionAtomically(db, inspectionInput),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await upsertCareInspectionAtomically(db, inspectionInput);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Inspection"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 1 });
  });

  it("rolls back health report and profile when the final timeline write fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER "fail_health_timeline" BEFORE INSERT ON "ServiceTimelineEvent"
      BEGIN SELECT RAISE(ABORT, 'injected health timeline failure'); END;
    `);
    await expect(upsertCareHealthReportAtomically(db, healthInput))
      .rejects.toThrow("injected health timeline failure");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleHealthReport"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleCareProfile"').get()).toEqual({ count: 0 });
  });

  it("rolls back the health report when the care-profile upsert fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER "fail_care_profile" BEFORE INSERT ON "VehicleCareProfile"
      BEGIN SELECT RAISE(ABORT, 'injected care profile failure'); END;
    `);
    await expect(upsertCareHealthReportAtomically(db, healthInput))
      .rejects.toThrow("injected care profile failure");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleHealthReport"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleCareProfile"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 0 });
  });

  it("deduplicates concurrent and sequential health-report replays by idempotency key", async () => {
    const outcomes = await Promise.allSettled([
      upsertCareHealthReportAtomically(db, healthInput),
      upsertCareHealthReportAtomically(db, healthInput),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await upsertCareHealthReportAtomically(db, healthInput);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleHealthReport"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "VehicleCareProfile"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT "healthScore" FROM "VehicleCareProfile"').get())
      .toEqual({ healthScore: 87 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceTimelineEvent"').get()).toEqual({ count: 1 });
  });
});
