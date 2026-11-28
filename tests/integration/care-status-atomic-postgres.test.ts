// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import { recordCareStatusTransition } from "@/lib/care-status-atomic";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("CARE status transition PostgreSQL transaction integration", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  let userId = "";
  let customerId = "";
  let vehicleId = "";
  const bookingIds: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const user = await db.user.create({
      data: {
        name: "CARE status transaction test",
        phone: `+9893${runId.slice(0, 9)}`,
        role: "CUSTOMER",
      },
    });
    userId = user.id;
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
        code: `CARE-STATUS-PG-${runId}-${suffix}`,
        userId,
        vehicleId,
        serviceType: "periodic",
        location: "Tehran",
        status: "ASSIGNED",
      },
    });
    bookingIds.push(booking.id);
    return booking;
  }

  async function withTimelineFailure(action: () => Promise<void>) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `care_status_fail_${token}`;
    const triggerName = `care_status_fail_trigger_${token}`;
    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected CARE status timeline failure'; END;
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

  it("rolls back the status update when the PostgreSQL timeline insert fails", async () => {
    const booking = await createBooking("rollback");
    await withTimelineFailure(async () => {
      await expect(recordCareStatusTransition(db as never, {
        bookingId: booking.id,
        expectedStatus: "ASSIGNED",
        expectedUpdatedAt: booking.updatedAt,
        nextStatus: "EN_ROUTE",
        technicianId: null,
        actorId: userId,
      })).rejects.toThrow("injected CARE status timeline failure");
    });

    const unchanged = await db!.serviceBooking.findUnique({ where: { id: booking.id } });
    expect(unchanged?.status).toBe("ASSIGNED");
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it("commits status and exactly one timeline event on PostgreSQL", async () => {
    const booking = await createBooking("commit");
    const updated = await recordCareStatusTransition(db as never, {
      bookingId: booking.id,
      expectedStatus: "ASSIGNED",
      expectedUpdatedAt: booking.updatedAt,
      nextStatus: "EN_ROUTE",
      technicianId: null,
      actorId: userId,
    });
    expect(updated?.status).toBe("EN_ROUTE");
    expect(await db!.serviceTimelineEvent.count({ where: { bookingId: booking.id } })).toBe(1);
  });
});
