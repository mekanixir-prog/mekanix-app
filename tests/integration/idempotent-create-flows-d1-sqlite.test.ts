// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => {
  class IdempotencyConflictError extends Error {
    constructor() {
      super("Idempotency-Key was already used with a different payload");
      this.name = "IdempotencyConflictError";
    }
  }
  return { getD1Binding: mocks.getD1Binding, IdempotencyConflictError };
});

import { IdempotencyConflictError } from "@/lib/idempotency";
import { createServiceRequestAtomically, ServiceRequestVehicleError } from "@/lib/service-request-atomic";
import { createInsuranceClaimAtomically } from "@/lib/insurance-claim-atomic";

const now = "2026-11-01T12:00:00.000Z";
const serviceInput = {
  idempotencyKey: "service-request:user-1:integration-001",
  requestFingerprint: '{"title":"engine fault"}',
  code: "SR-INTEGRATION-001",
  customerId: "customer-1",
  actorUserId: "user-1",
  vehicleId: "vehicle-1",
  category: "engine",
  urgency: "URGENT" as const,
  title: "Engine fault",
  description: "Power loss",
  mediaUrls: "[]",
  voiceNote: null,
  address: "Tehran",
  lat: 35.7,
  lng: 51.4,
};
const claimInput = {
  idempotencyKey: "insurance-claim:user-1:integration-001",
  requestFingerprint: '{"amount":250}',
  code: "CLM-INTEGRATION-001",
  policyId: "policy-1",
  jobId: null,
  description: "Accident damage",
  amount: 250,
};

function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "Vehicle" (
      "id" TEXT PRIMARY KEY,
      "customerId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "make" TEXT NOT NULL,
      "model" TEXT NOT NULL,
      "year" INTEGER NOT NULL,
      "plate" TEXT,
      "location" TEXT,
      "lat" REAL,
      "lng" REAL,
      "notes" TEXT,
      "createdAt" TEXT NOT NULL
    );
    CREATE TABLE "ServiceRequest" (
      "id" TEXT PRIMARY KEY,
      "code" TEXT NOT NULL UNIQUE,
      "customerId" TEXT NOT NULL,
      "vehicleId" TEXT NOT NULL REFERENCES "Vehicle"("id"),
      "category" TEXT NOT NULL,
      "urgency" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "mediaUrls" TEXT NOT NULL,
      "voiceNote" TEXT,
      "address" TEXT NOT NULL,
      "lat" REAL NOT NULL,
      "lng" REAL NOT NULL,
      "status" TEXT NOT NULL,
      "idempotencyKey" TEXT UNIQUE,
      "requestFingerprint" TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE "InsurancePolicy" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED'
    );
    CREATE TABLE "InsuranceClaim" (
      "id" TEXT PRIMARY KEY,
      "code" TEXT NOT NULL UNIQUE,
      "policyId" TEXT NOT NULL REFERENCES "InsurancePolicy"("id"),
      "jobId" TEXT,
      "description" TEXT NOT NULL,
      "amount" REAL NOT NULL,
      "financialUnitStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "status" TEXT NOT NULL,
      "idempotencyKey" TEXT UNIQUE,
      "requestFingerprint" TEXT,
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
    async batch(items: Array<{ sql: string; values: unknown[] }>) {
      sqlite.exec("BEGIN");
      try {
        const results = items.map(({ sql, values }) => {
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

function seedServiceVehicle(sqlite: DatabaseSync) {
  sqlite.prepare(`INSERT INTO "Vehicle" ("id", "customerId", "type", "make", "model", "year", "createdAt")
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "vehicle-1", "customer-1", "EXCAVATOR", "CAT", "320", 2024, now
  );
}

function makeDb(sqlite: DatabaseSync) {
  return {
    vehicle: {
      findUnique: async ({ where }: any) =>
        sqlite.prepare('SELECT "id", "customerId", "type", "make" FROM "Vehicle" WHERE "id" = ?').get(where.id) ?? null,
    },
    serviceRequest: {
      findUnique: async ({ where }: any) =>
        sqlite.prepare('SELECT "id", "requestFingerprint" FROM "ServiceRequest" WHERE "idempotencyKey" = ?')
          .get(where.idempotencyKey) ?? null,
    },
    insuranceClaim: {
      findUnique: async ({ where }: any) =>
        sqlite.prepare('SELECT "id", "code", "policyId", "requestFingerprint" FROM "InsuranceClaim" WHERE "idempotencyKey" = ?')
          .get(where.idempotencyKey) ?? null,
    },
    insurancePolicy: {
      findUnique: async ({ where }: any) =>
        sqlite.prepare('SELECT "status", "financialUnitStatus" FROM "InsurancePolicy" WHERE "id" = ?')
          .get(where.id) ?? null,
    },
  } as any;
}

describe("D1 SQLite atomic service request and insurance claim creation", () => {
  const databases: DatabaseSync[] = [];
  beforeEach(() => mocks.getD1Binding.mockReset());
  afterEach(() => {
    vi.clearAllMocks();
    for (const database of databases.splice(0)) database.close();
  });

  it("creates one service request for a registered vehicle under 100 concurrent retries", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    seedServiceVehicle(sqlite);
    mocks.getD1Binding.mockResolvedValue(d1);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        createServiceRequestAtomically(makeDb(sqlite), serviceInput)
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Vehicle"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceRequest"').get()).toEqual({ count: 1 });
  });

  it("rechecks passenger vehicle scope in the D1 insert if the vehicle changes after preflight", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    seedServiceVehicle(sqlite);
    sqlite.prepare('UPDATE "Vehicle" SET "type" = ?, "make" = ? WHERE "id" = ?')
      .run("CAR", "IKCO", "vehicle-1");

    // Simulate a supported preflight read followed by an out-of-scope stored
    // value at the atomic SQL write boundary.
    const db = makeDb(sqlite);
    db.vehicle.findUnique = async () => ({
      id: "vehicle-1",
      customerId: "customer-1",
      type: "CAR",
      make: "Kerman Motor",
    });
    mocks.getD1Binding.mockResolvedValue(d1);

    await expect(createServiceRequestAtomically(db, serviceInput))
      .rejects.toBeInstanceOf(ServiceRequestVehicleError);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceRequest"').get()).toEqual({ count: 0 });
  });

  it("does not create a request when the registered vehicle request insert fails", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    seedServiceVehicle(sqlite);
    sqlite.exec(`CREATE TRIGGER "fail_service_request" BEFORE INSERT ON "ServiceRequest"
      BEGIN SELECT RAISE(ABORT, 'request insert failed'); END;`);
    mocks.getD1Binding.mockResolvedValue(d1);

    await expect(createServiceRequestAtomically(makeDb(sqlite), serviceInput))
      .rejects.toThrow("request insert failed");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Vehicle"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "ServiceRequest"').get()).toEqual({ count: 0 });
  });

  it("replays the same service request and rejects a reused key with a different fingerprint", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    seedServiceVehicle(sqlite);
    mocks.getD1Binding.mockResolvedValue(d1);
    const db = makeDb(sqlite);

    const first = await createServiceRequestAtomically(db, serviceInput);
    const replay = await createServiceRequestAtomically(db, serviceInput);
    await expect(createServiceRequestAtomically(db, {
      ...serviceInput,
      requestFingerprint: '{"title":"different"}',
    })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(first.id).toBe(replay.id);
    expect(replay.created).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "Vehicle"').get()).toEqual({ count: 1 });
  });

  it("creates and updates an insurance claim exactly once under 100 concurrent retries", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.prepare('INSERT INTO "InsurancePolicy" ("id", "userId", "status", "financialUnitStatus") VALUES (?, ?, ?, ?)')
      .run("policy-1", "user-1", "active", "VERIFIED_IRR");
    mocks.getD1Binding.mockResolvedValue(d1);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        createInsuranceClaimAtomically(makeDb(sqlite), claimInput)
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "InsuranceClaim"').get()).toEqual({ count: 1 });
    expect(sqlite.prepare('SELECT "status", "financialUnitStatus" FROM "InsurancePolicy" WHERE "id" = ?').get("policy-1"))
      .toEqual({ status: "claimed", financialUnitStatus: "VERIFIED_IRR" });
  });

  it("rolls back the claim insert when the policy status transition fails", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.prepare('INSERT INTO "InsurancePolicy" ("id", "userId", "status", "financialUnitStatus") VALUES (?, ?, ?, ?)')
      .run("policy-1", "user-1", "active", "VERIFIED_IRR");
    sqlite.exec(`CREATE TRIGGER "fail_policy_update" BEFORE UPDATE ON "InsurancePolicy"
      BEGIN SELECT RAISE(ABORT, 'policy update failed'); END;`);
    mocks.getD1Binding.mockResolvedValue(d1);

    await expect(createInsuranceClaimAtomically(makeDb(sqlite), claimInput))
      .rejects.toThrow("policy update failed");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "InsuranceClaim"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT "status", "financialUnitStatus" FROM "InsurancePolicy" WHERE "id" = ?').get("policy-1"))
      .toEqual({ status: "active", financialUnitStatus: "VERIFIED_IRR" });
  });

  it("does not create a claim for an expired policy", async () => {
    const { sqlite, d1 } = makeD1();
    databases.push(sqlite);
    sqlite.prepare('INSERT INTO "InsurancePolicy" ("id", "userId", "status", "financialUnitStatus") VALUES (?, ?, ?, ?)')
      .run("policy-1", "user-1", "expired", "VERIFIED_IRR");
    mocks.getD1Binding.mockResolvedValue(d1);

    await expect(createInsuranceClaimAtomically(makeDb(sqlite), claimInput))
      .rejects.toThrow("no longer eligible");
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM "InsuranceClaim"').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT "status", "financialUnitStatus" FROM "InsurancePolicy" WHERE "id" = ?').get("policy-1"))
      .toEqual({ status: "expired", financialUnitStatus: "VERIFIED_IRR" });
  });
});
