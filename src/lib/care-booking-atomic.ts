import type { PrismaClient } from "@prisma/client";

type Pricing = {
  labor: number;
  travel: number;
  inspection: number;
  parts: number;
  discount: number;
  taxRate: number;
  taxTotal: number;
  total: number;
  currency: string;
  pricingVersion: string;
};

export type CareBookingInput = {
  idempotencyKey: string;
  requestFingerprint: string;
  code: string;
  userId: string;
  vehicleId: string;
  packageId: string | null;
  serviceType: string;
  location: string;
  lat: number | null;
  lng: number | null;
  date: Date | null;
  timeWindow: string | null;
  currentMileage: number | null;
  pricing: Pricing;
};

type D1Result = { meta?: { changes?: number } };
type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

export class CareBookingIdempotencyConflict extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different booking payload");
    this.name = "CareBookingIdempotencyConflict";
  }
}

function assertSameRequest(booking: { requestFingerprint: string | null }, fingerprint: string) {
  if (booking.requestFingerprint !== fingerprint) throw new CareBookingIdempotencyConflict();
}

async function createWithPrisma(db: PrismaClient, input: CareBookingInput) {
  return db.$transaction(async (tx) => {
    const existing = await tx.serviceBooking.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      assertSameRequest(existing, input.requestFingerprint);
      return existing;
    }

    const booking = await tx.serviceBooking.create({
      data: {
        code: input.code,
        userId: input.userId,
        vehicleId: input.vehicleId,
        packageId: input.packageId,
        serviceType: input.serviceType,
        location: input.location,
        lat: input.lat,
        lng: input.lng,
        date: input.date,
        timeWindow: input.timeWindow,
        currentMileage: input.currentMileage,
        status: "REQUESTED",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      },
    });

    const snapshot = await tx.pricingSnapshot.create({
      data: {
        bookingId: booking.id,
        servicePrice: input.pricing.labor,
        visitPrice: input.pricing.travel,
        inspectionPrice: input.pricing.inspection,
        financialUnitStatus: "VERIFIED_IRR",
        laborPrice: input.pricing.labor,
        partsPrice: input.pricing.parts,
        discount: input.pricing.discount,
        taxRate: input.pricing.taxRate,
        taxTotal: input.pricing.taxTotal,
        total: input.pricing.total,
        currency: input.pricing.currency,
        pricingVersion: input.pricing.pricingVersion,
      },
    });

    await tx.serviceBooking.update({
      where: { id: booking.id },
      data: { pricingSnapshotId: snapshot.id },
    });

    await tx.serviceTimelineEvent.create({
      data: {
        bookingId: booking.id,
        eventType: "booking_created",
        actor: input.userId,
        idempotencyKey: `care-booking:${input.idempotencyKey}:created`,
      },
    });
    return booking;
  });
}

/**
 * D1 batch is a single transactional unit. The unique booking key gates every
 * dependent INSERT; the fingerprint prevents a reused key from linking or
 * creating records for a different payload. Unique dependent keys make a
 * duplicate request a no-op rather than a second booking or timeline event.
 */
async function createWithD1(d1: D1Database, input: CareBookingInput) {
  const now = new Date().toISOString();
  const date = input.date?.toISOString() ?? null;
  const bookingId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const p = input.pricing;

  await d1.batch([
    d1.prepare(`
      INSERT INTO "ServiceBooking"
        ("id", "code", "userId", "vehicleId", "packageId", "serviceType",
         "location", "lat", "lng", "date", "timeWindow", "currentMileage",
         "status", "idempotencyKey", "requestFingerprint", "createdAt", "updatedAt")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?)
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      bookingId, input.code, input.userId, input.vehicleId, input.packageId,
      input.serviceType, input.location, input.lat, input.lng, date,
      input.timeWindow, input.currentMileage, input.idempotencyKey,
      input.requestFingerprint, now, now
    ),
    d1.prepare(`
      INSERT INTO "PricingSnapshot"
        ("id", "bookingId", "servicePrice", "visitPrice", "inspectionPrice", "laborPrice",
         "partsPrice", "discount", "taxRate", "taxTotal", "total",
         "currency", "pricingVersion", "financialUnitStatus", "createdAt")
      SELECT ?, "id", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM "ServiceBooking"
      WHERE "idempotencyKey" = ? AND "requestFingerprint" = ?
      ON CONFLICT("bookingId") DO NOTHING
    `).bind(
      snapshotId, p.labor, p.travel, p.inspection, p.labor, p.parts, p.discount,
      p.taxRate, p.taxTotal, p.total, p.currency, p.pricingVersion, "VERIFIED_IRR", now,
      input.idempotencyKey, input.requestFingerprint
    ),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "pricingSnapshotId" = (
        SELECT "id" FROM "PricingSnapshot" WHERE "bookingId" = "ServiceBooking"."id"
      ), "updatedAt" = ?
      WHERE "idempotencyKey" = ? AND "requestFingerprint" = ?
        AND "pricingSnapshotId" IS NULL
        AND EXISTS (SELECT 1 FROM "PricingSnapshot" ps WHERE ps."bookingId" = "ServiceBooking"."id")
    `).bind(now, input.idempotencyKey, input.requestFingerprint),
    d1.prepare(`
      INSERT INTO "ServiceTimelineEvent"
        ("id", "bookingId", "eventType", "timestamp", "actor", "idempotencyKey")
      SELECT ?, "id", 'booking_created', ?, ?, ?
      FROM "ServiceBooking"
      WHERE "idempotencyKey" = ? AND "requestFingerprint" = ?
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      eventId, now, input.userId,
      `care-booking:${input.idempotencyKey}:created`,
      input.idempotencyKey, input.requestFingerprint
    ),
  ]);
}

export async function createCareBookingAtomically(
  db: PrismaClient,
  input: CareBookingInput
) {
  const existing = await db.serviceBooking.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) {
    assertSameRequest(existing, input.requestFingerprint);
    return existing;
  }

  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";

  try {
    if (isWorker) {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const context = await getCloudflareContext({ async: true });
      const d1 = (context.env as unknown as { DB?: D1Database }).DB;
      if (!d1) throw new Error("D1 binding 'DB' is unavailable for atomic CARE booking");
      await createWithD1(d1, input);
    } else {
      await createWithPrisma(db, input);
    }
  } catch (error) {
    // A concurrent request may have won the unique-key race. Only replay it
    // when the stored fingerprint is identical; never hide unrelated errors.
    const raced = await db.serviceBooking.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (!raced) throw error;
    assertSameRequest(raced, input.requestFingerprint);
    return raced;
  }

  const booking = await db.serviceBooking.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (!booking) throw new Error("CARE booking batch completed without a readable booking");
  assertSameRequest(booking, input.requestFingerprint);
  return booking;
}
