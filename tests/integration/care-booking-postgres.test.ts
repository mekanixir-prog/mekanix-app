// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { createCareBookingAtomically } from "@/lib/care-booking-atomic";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("CARE booking PostgreSQL transaction integration", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>>;
  let userId: string;
  let customerId: string;
  let vehicleId: string;
  const bookingKeys: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const user = await db.user.create({
      data: {
        name: "CARE PostgreSQL Test",
        phone: `+9892${runId.slice(0, 9)}`,
        role: "CUSTOMER",
      },
    });
    userId = user.id;
    const customer = await db.customer.create({ data: { userId } });
    customerId = customer.id;
    const vehicle = await db.vehicle.create({
      data: {
        customerId,
        type: "EXCAVATOR",
        make: "CAT",
        model: "320",
        year: 2024,
      },
    });
    vehicleId = vehicle.id;
  });

  afterAll(async () => {
    if (db) {
      await db.serviceTimelineEvent.deleteMany({
        where: { booking: { userId } },
      });
      await db.pricingSnapshot.deleteMany({
        where: { bookingId: { in: bookingKeys.map((key) => key) } },
      }).catch(() => undefined);
      await db.serviceBooking.deleteMany({
        where: { idempotencyKey: { in: bookingKeys } },
      });
      if (vehicleId) await db.vehicle.deleteMany({ where: { id: vehicleId } });
      if (customerId) await db.customer.deleteMany({ where: { id: customerId } });
      if (userId) await db.user.deleteMany({ where: { id: userId } });
    }
    vi.unstubAllEnvs();
  });

  function makeInput(suffix: string) {
    const idempotencyKey = `care-booking:pg-test:${runId}:${suffix}`;
    bookingKeys.push(idempotencyKey);
    return {
      idempotencyKey,
      requestFingerprint: JSON.stringify({ userId, vehicleId, serviceType: "periodic", suffix }),
      code: `CARE-PG-${runId}-${suffix}`,
      userId,
      vehicleId,
      packageId: null,
      serviceType: "periodic",
      location: "Tehran",
      lat: 35.7,
      lng: 51.4,
      date: new Date("2026-11-02T00:00:00.000Z"),
      timeWindow: "09:00-11:00",
      currentMileage: 12000,
      pricing: {
        labor: 50000,
        travel: 15000,
        parts: 0,
        discount: 0,
        taxRate: 0.09,
        taxTotal: 5850,
        total: 70850,
        currency: "IRR",
        pricingVersion: "2.1",
      },
    };
  }

  async function withFailureTrigger(
    suffix: string,
    table: string,
    event: string,
    condition: string,
    failureMessage: string,
    action: () => Promise<void>
  ) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `test_care_fail_${token}`;
    const triggerName = `test_care_fail_trigger_${token}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION '${failureMessage}'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" ${event} ON "${table}"
      FOR EACH ROW WHEN (${condition})
      EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await action();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${table}"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  it("creates one booking, pricing snapshot, link and timeline event for 80 concurrent identical retries", async () => {
    const input = makeInput("concurrent");
    const results = await Promise.all(
      Array.from({ length: 80 }, () => createCareBookingAtomically(db, input))
    );

    expect(new Set(results.map((booking) => booking.id)).size).toBe(1);
    expect(await db.serviceBooking.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
    const booking = await db.serviceBooking.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    expect(booking?.pricingSnapshotId).toBeTruthy();
    expect(await db.pricingSnapshot.count({ where: { bookingId: booking!.id } })).toBe(1);
    expect(await db.serviceTimelineEvent.count({
      where: { idempotencyKey: `care-booking:${input.idempotencyKey}:created` },
    })).toBe(1);
  });

  it("rolls back booking when pricing snapshot insert fails", async () => {
    const input = makeInput("fail-snapshot");
    await withFailureTrigger(
      "snapshot",
      "PricingSnapshot",
      "BEFORE INSERT",
      `EXISTS (SELECT 1 FROM "ServiceBooking" WHERE "id" = NEW."bookingId" AND "code" = '${input.code}')`,
      "injected pricing snapshot failure",
      async () => {
        await expect(createCareBookingAtomically(db, input))
          .rejects.toThrow("injected pricing snapshot failure");
      }
    );
    expect(await db.serviceBooking.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
    expect(await db.pricingSnapshot.count({ where: { bookingId: { in: await db.serviceBooking.findMany({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } }).then((rows) => rows.map((row) => row.id)) } } })).toBe(0);
  });

  it("rolls back booking and pricing when snapshot-link update fails", async () => {
    const input = makeInput("fail-link");
    await withFailureTrigger(
      "snapshot-link",
      "ServiceBooking",
      "BEFORE UPDATE OF \"pricingSnapshotId\"",
      `OLD."code" = '${input.code}'`,
      "injected snapshot link failure",
      async () => {
        await expect(createCareBookingAtomically(db, input))
          .rejects.toThrow("injected snapshot link failure");
      }
    );
    expect(await db.serviceBooking.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
  });

  it("rolls back booking, pricing and link when timeline insert fails", async () => {
    const input = makeInput("fail-timeline");
    await withFailureTrigger(
      "timeline",
      "ServiceTimelineEvent",
      "BEFORE INSERT",
      `EXISTS (SELECT 1 FROM "ServiceBooking" WHERE "id" = NEW."bookingId" AND "code" = '${input.code}')`,
      "injected timeline event failure",
      async () => {
        await expect(createCareBookingAtomically(db, input))
          .rejects.toThrow("injected timeline event failure");
      }
    );
    expect(await db.serviceBooking.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(0);
  });
});
