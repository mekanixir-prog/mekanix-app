// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import {
  createCareFindingAtomically,
  upsertCareHealthReportAtomically,
  upsertCareInspectionAtomically,
} from "@/lib/care-record-atomic";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("CARE record PostgreSQL atomicity integration", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  let userId = "";
  let customerId = "";
  let vehicleId = "";
  const bookingIds: string[] = [];

  const actor = {
    actorRole: "ADMIN" as const,
    actorUserId: "",
    actorTechnicianId: null,
    idempotencyKey: "care-record-postgres-test-key",
    requestFingerprint: "sha256:care-record-postgres-test-fingerprint",
  };

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const user = await db.user.create({
      data: {
        name: "CARE record atomicity test",
        phone: `+9893${runId.slice(0, 9)}`,
        role: "CUSTOMER",
      },
    });
    userId = user.id;
    actor.actorUserId = userId;
    const customer = await db.customer.create({ data: { userId } });
    customerId = customer.id;
    const vehicle = await db.vehicle.create({
      data: { customerId, type: "EXCAVATOR", make: "CAT", model: "320", year: 2024 },
    });
    vehicleId = vehicle.id;
  });

  afterAll(async () => {
    if (db) {
      await db.serviceTimelineEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.finding.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.inspection.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.vehicleHealthReport.deleteMany({ where: { bookingId: { in: bookingIds } } });
      if (vehicleId) await db.vehicleCareProfile.deleteMany({ where: { vehicleId } });
      await db.serviceBooking.deleteMany({ where: { id: { in: bookingIds } } });
      if (vehicleId) await db.vehicle.deleteMany({ where: { id: vehicleId } });
      if (customerId) await db.customer.deleteMany({ where: { id: customerId } });
      if (userId) await db.user.deleteMany({ where: { id: userId } });
    }
    vi.unstubAllEnvs();
  });

  async function createBooking(suffix: string) {
    const booking = await db!.serviceBooking.create({
      data: {
        code: `CARE-RECORD-PG-${runId}-${suffix}`,
        userId,
        vehicleId,
        serviceType: "periodic",
        location: "Tehran",
        status: "INSPECTING",
      },
    });
    bookingIds.push(booking.id);
    return booking.id;
  }

  async function withTimelineFailure(action: () => Promise<unknown>) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `care_record_fail_${token}`;
    const triggerName = `care_record_fail_trigger_${token}`;
    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected CARE record timeline failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "ServiceTimelineEvent"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await action();
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "ServiceTimelineEvent"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  async function withCareProfileFailure(action: () => Promise<unknown>) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `care_profile_fail_${token}`;
    const triggerName = `care_profile_fail_trigger_${token}`;
    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected CARE profile failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT OR UPDATE ON "VehicleCareProfile"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await action();
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "VehicleCareProfile"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  function findingInput(bookingId: string) {
    return {
      bookingId, ...actor,
      idempotencyKey: `care-finding:${bookingId}`,
      requestFingerprint: "sha256:finding-test-payload",
      category: "engine", title: "Oil leak",
      description: "Leak near filter", severity: "HIGH",
      evidence: JSON.stringify({ images: [] }), recommendedAction: "Replace seal",
    };
  }

  function inspectionInput(bookingId: string, notes = "Checked") {
    return {
      bookingId, ...actor,
      idempotencyKey: `care-inspection:${bookingId}`,
      requestFingerprint: `sha256:inspection-${notes}`,
      results: JSON.stringify({ engine: { oil: "PASS" } }),
      measurements: JSON.stringify({ voltage: "12.4V" }),
      images: JSON.stringify([]), technicianNotes: notes,
    };
  }

  function healthInput(bookingId: string, overallScore = 87) {
    return {
      bookingId, ...actor,
      idempotencyKey: `care-health-report:${bookingId}`,
      requestFingerprint: `sha256:health-report-${overallScore}`,
      overallScore, engineScore: 90, oilScore: 85,
      brakeScore: null, batteryScore: null, tireScore: null, filterScore: null,
      fluidScore: null, coolingScore: null, beltScore: null, leakScore: null,
      diagnosticScore: null, categories: JSON.stringify({ engine: 90 }),
      evidence: JSON.stringify({}),
    };
  }

  it("rolls back a finding when the timeline insert fails", async () => {
    const bookingId = await createBooking("finding-rollback");
    await withTimelineFailure(async () => {
      await expect(createCareFindingAtomically(db as never, findingInput(bookingId)))
        .rejects.toThrow("injected CARE record timeline failure");
    });
    expect(await db!.finding.count({ where: { bookingId } })).toBe(0);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(0);
  });

  it("deduplicates concurrent and sequential finding replays by idempotency key", async () => {
    const bookingId = await createBooking("finding-concurrent");
    const outcomes = await Promise.allSettled([
      createCareFindingAtomically(db as never, findingInput(bookingId)),
      createCareFindingAtomically(db as never, findingInput(bookingId)),
    ]);
    expect(outcomes.every((item) => item.status === "fulfilled")).toBe(true);
    const replayed = outcomes.map((item) => item.status === "fulfilled" ? item.value : null);
    expect(replayed[0]?.id).toBe(replayed[1]?.id);
    await createCareFindingAtomically(db as never, findingInput(bookingId));
    expect(await db!.finding.count({ where: { bookingId } })).toBe(1);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(1);
  });

  it("rolls back an inspection upsert when the timeline insert fails", async () => {
    const bookingId = await createBooking("inspection-rollback");
    await withTimelineFailure(async () => {
      await expect(upsertCareInspectionAtomically(db as never, inspectionInput(bookingId)))
        .rejects.toThrow("injected CARE record timeline failure");
    });
    expect(await db!.inspection.count({ where: { bookingId } })).toBe(0);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(0);
  });

  it("deduplicates concurrent and sequential inspection replays by idempotency key", async () => {
    const bookingId = await createBooking("inspection-replay");
    const outcomes = await Promise.allSettled([
      upsertCareInspectionAtomically(db as never, inspectionInput(bookingId)),
      upsertCareInspectionAtomically(db as never, inspectionInput(bookingId)),
    ]);
    expect(outcomes.every((item) => item.status === "fulfilled")).toBe(true);
    const replayed = outcomes.map((item) => item.status === "fulfilled" ? item.value : null);
    expect(replayed[0]?.id).toBe(replayed[1]?.id);
    await upsertCareInspectionAtomically(db as never, inspectionInput(bookingId));
    expect(await db!.inspection.count({ where: { bookingId } })).toBe(1);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(1);
  });

  it("rolls back health report and profile when the timeline insert fails", async () => {
    const bookingId = await createBooking("health-rollback");
    await withTimelineFailure(async () => {
      await expect(upsertCareHealthReportAtomically(db as never, healthInput(bookingId)))
        .rejects.toThrow("injected CARE record timeline failure");
    });
    expect(await db!.vehicleHealthReport.count({ where: { bookingId } })).toBe(0);
    expect(await db!.vehicleCareProfile.count({ where: { vehicleId } })).toBe(0);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(0);
  });

  it("rolls back the health report when the PostgreSQL care-profile upsert fails", async () => {
    const bookingId = await createBooking("health-profile-rollback");
    await withCareProfileFailure(async () => {
      await expect(upsertCareHealthReportAtomically(db as never, healthInput(bookingId)))
        .rejects.toThrow("injected CARE profile failure");
    });
    expect(await db!.vehicleHealthReport.count({ where: { bookingId } })).toBe(0);
    expect(await db!.vehicleCareProfile.count({ where: { vehicleId } })).toBe(0);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(0);
  });

  it("deduplicates concurrent and sequential health-report replays by idempotency key", async () => {
    const bookingId = await createBooking("health-replay");
    const outcomes = await Promise.allSettled([
      upsertCareHealthReportAtomically(db as never, healthInput(bookingId)),
      upsertCareHealthReportAtomically(db as never, healthInput(bookingId)),
    ]);
    expect(outcomes.every((item) => item.status === "fulfilled")).toBe(true);
    const replayed = outcomes.map((item) => item.status === "fulfilled" ? item.value : null);
    expect(replayed[0]?.id).toBe(replayed[1]?.id);
    await upsertCareHealthReportAtomically(db as never, healthInput(bookingId));
    expect(await db!.vehicleHealthReport.count({ where: { bookingId } })).toBe(1);
    expect(await db!.vehicleCareProfile.count({ where: { vehicleId } })).toBe(1);
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId } })).toBe(1);
  });
});
