import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

type CareActor = {
  actorRole: "TECHNICIAN" | "ADMIN";
  actorUserId: string;
  actorTechnicianId: string | null;
};

type BookingInput = CareActor & {
  bookingId: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type CreateFindingInput = BookingInput & {
  category: string;
  title: string;
  description: string | null;
  severity: string;
  evidence: string;
  recommendedAction: string | null;
};

export type UpsertInspectionInput = BookingInput & {
  results: string;
  measurements: string;
  images: string;
  technicianNotes: string | null;
};

export type UpsertHealthReportInput = BookingInput & {
  overallScore: number;
  engineScore: number | null;
  oilScore: number | null;
  brakeScore: number | null;
  batteryScore: number | null;
  tireScore: number | null;
  filterScore: number | null;
  fluidScore: number | null;
  coolingScore: number | null;
  beltScore: number | null;
  leakScore: number | null;
  diagnosticScore: number | null;
  categories: string;
  evidence: string;
};

export class CareRecordConflictError extends Error {
  constructor() {
    super("The booking or technician assignment changed before the CARE record could be committed");
    this.name = "CareRecordConflictError";
  }
}

export class CareRecordNotFoundError extends Error {
  constructor() {
    super("CARE booking was not found");
    this.name = "CareRecordNotFoundError";
  }
}

export class CareRecordIdempotencyConflictError extends Error {
  constructor() {
    super("The CARE Idempotency-Key was already used with a different payload");
    this.name = "CareRecordIdempotencyConflictError";
  }
}

type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
};

const assertOneChange = (d1: D1Database) =>
  d1.prepare(
    "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END"
  ).bind();

type CareRecordKind = "finding" | "inspection" | "health-report";

async function findCareRecordReplay(db: any, input: BookingInput, kind: CareRecordKind) {
  const event = await db.serviceTimelineEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { metadata: true, bookingId: true, eventType: true },
  });
  if (!event) return null;
  const expectedEventType = kind === "finding"
    ? "extra_proposal"
    : kind === "inspection"
      ? "inspection_started"
      : "health_report_created";
  if (event.bookingId !== input.bookingId || event.eventType !== expectedEventType) {
    throw new CareRecordIdempotencyConflictError();
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(event.metadata ?? "{}") as Record<string, unknown>;
  } catch {
    throw new CareRecordIdempotencyConflictError();
  }
  if (metadata.requestFingerprint !== input.requestFingerprint) {
    throw new CareRecordIdempotencyConflictError();
  }

  if (kind === "finding") {
    if (typeof metadata.findingId !== "string") throw new CareRecordIdempotencyConflictError();
    const finding = await db.finding.findUnique({ where: { id: metadata.findingId } });
    if (!finding) throw new Error("CARE finding idempotency record points to a missing finding");
    return finding;
  }
  if (kind === "inspection") {
    const inspection = await db.inspection.findUnique({ where: { bookingId: input.bookingId } });
    if (!inspection) throw new Error("CARE inspection idempotency record points to a missing inspection");
    return inspection;
  }
  const report = await db.vehicleHealthReport.findUnique({ where: { bookingId: input.bookingId } });
  if (!report) throw new Error("CARE health-report idempotency record points to a missing report");
  return report;
}

async function claimBookingPrisma(tx: any, input: BookingInput, updatedAt: Date) {
  const current = await tx.serviceBooking.findUnique({
    where: { id: input.bookingId },
    select: { id: true, updatedAt: true, vehicleId: true },
  });
  if (!current) throw new CareRecordNotFoundError();

  const claim = await tx.serviceBooking.updateMany({
    where: {
      id: input.bookingId,
      updatedAt: current.updatedAt,
      ...(input.actorRole === "TECHNICIAN"
        ? { technicianId: input.actorTechnicianId ?? "__missing_technician__" }
        : {}),
    },
    data: { updatedAt },
  });
  if (claim.count !== 1) throw new CareRecordConflictError();
  return current;
}

async function d1BookingClaim(
  db: PrismaClient,
  d1: D1Database,
  input: BookingInput,
  updatedAt: string,
) {
  const current = await db.serviceBooking.findUnique({
    where: { id: input.bookingId },
    select: { id: true, updatedAt: true },
  });
  if (!current) throw new CareRecordNotFoundError();

  return [
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "updatedAt" = ?
      WHERE "id" = ? AND "updatedAt" = ?
        AND (
          ? = 'ADMIN'
          OR ("technicianId" = ? AND ? IS NOT NULL)
        )
    `).bind(
      updatedAt,
      input.bookingId,
      current.updatedAt instanceof Date ? current.updatedAt.toISOString() : current.updatedAt,
      input.actorRole,
      input.actorTechnicianId,
      input.actorTechnicianId,
    ),
    assertOneChange(d1),
  ];
}

async function throwD1BookingGuardError(
  db: PrismaClient,
  input: BookingInput,
  error: unknown,
): Promise<never> {
  if (error instanceof Error && /malformed JSON/i.test(error.message)) {
    const booking = await db.serviceBooking.findUnique({
      where: { id: input.bookingId },
      select: { id: true },
    });
    if (!booking) throw new CareRecordNotFoundError();
    throw new CareRecordConflictError();
  }
  throw error;
}

async function runD1CareBatch(
  db: PrismaClient,
  input: BookingInput,
  d1: D1Database,
  statements: D1Statement[],
) {
  try {
    await d1.batch(statements);
  } catch (error) {
    await throwD1BookingGuardError(db, input, error);
  }
}

export async function createCareFindingAtomically(db: PrismaClient, input: CreateFindingInput) {
  const d1 = await getD1Binding();
  const findingId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date();
  const replay = await findCareRecordReplay(db, input, "finding");
  if (replay) return replay;

  if (d1) {
    const timestamp = now.toISOString();
    await runD1CareBatch(db, input, d1, [
      ...await d1BookingClaim(db, d1, input, timestamp),
      d1.prepare(`
        INSERT INTO "Finding"
          ("id", "bookingId", "category", "title", "description", "severity",
           "evidence", "recommendedAction", "createdAt")
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM "ServiceBooking"
        WHERE "id" = ? AND "updatedAt" = ?
      `).bind(
        findingId, input.bookingId, input.category, input.title, input.description,
        input.severity, input.evidence, input.recommendedAction, timestamp,
        input.bookingId, timestamp,
      ),
      assertOneChange(d1),
      d1.prepare(`
        INSERT INTO "ServiceTimelineEvent"
          ("id", "bookingId", "eventType", "timestamp", "actor", "metadata", "idempotencyKey")
        SELECT ?, ?, 'extra_proposal', ?, ?, ?, ?
        FROM "ServiceBooking"
        WHERE "id" = ? AND "updatedAt" = ?
        ON CONFLICT("idempotencyKey") DO NOTHING
      `).bind(
        eventId, input.bookingId, timestamp, input.actorUserId,
        JSON.stringify({ findingId, requestFingerprint: input.requestFingerprint }),
        input.idempotencyKey, input.bookingId, timestamp,
      ),
      assertOneChange(d1),
    ]);
    const created = await db.finding.findUnique({ where: { id: findingId } });
    if (!created) throw new Error("CARE finding could not be loaded after D1 batch");
    return created;
  }

  try {
    return await db.$transaction(async (tx) => {
    await claimBookingPrisma(tx, input, now);
    const created = await tx.finding.create({
      data: {
        id: findingId,
        bookingId: input.bookingId,
        category: input.category,
        title: input.title,
        description: input.description,
        severity: input.severity,
        evidence: input.evidence,
        recommendedAction: input.recommendedAction,
        createdAt: now,
      },
    });
    await tx.serviceTimelineEvent.create({
      data: {
        id: eventId,
        bookingId: input.bookingId,
        eventType: "extra_proposal",
        actor: input.actorUserId,
        metadata: JSON.stringify({ findingId: created.id, requestFingerprint: input.requestFingerprint }),
        idempotencyKey: input.idempotencyKey,
        timestamp: now,
      },
    });
      return created;
    });
  } catch (error) {
    const replay = await findCareRecordReplay(db, input, "finding");
    if (replay) return replay;
    throw error;
  }
}

export async function upsertCareInspectionAtomically(db: PrismaClient, input: UpsertInspectionInput) {
  const d1 = await getD1Binding();
  const inspectionId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date();
  const replay = await findCareRecordReplay(db, input, "inspection");
  if (replay) return replay;

  if (d1) {
    const timestamp = now.toISOString();
    await runD1CareBatch(db, input, d1, [
      ...await d1BookingClaim(db, d1, input, timestamp),
      d1.prepare(`
        INSERT INTO "Inspection"
          ("id", "bookingId", "checklistVersion", "results", "measurements",
           "images", "technicianNotes", "createdAt", "updatedAt")
        SELECT ?, ?, '1.0', ?, ?, ?, ?, ?, ?
        FROM "ServiceBooking"
        WHERE "id" = ? AND "updatedAt" = ?
        ON CONFLICT("bookingId") DO UPDATE SET
          "results" = excluded."results",
          "measurements" = excluded."measurements",
          "images" = excluded."images",
          "technicianNotes" = excluded."technicianNotes",
          "updatedAt" = excluded."updatedAt"
      `).bind(
        inspectionId, input.bookingId, input.results, input.measurements,
        input.images, input.technicianNotes, timestamp, timestamp,
        input.bookingId, timestamp,
      ),
      assertOneChange(d1),
      d1.prepare(`
        INSERT INTO "ServiceTimelineEvent"
          ("id", "bookingId", "eventType", "timestamp", "actor", "metadata", "idempotencyKey")
        SELECT ?, ?, 'inspection_started', ?, ?, ?, ?
        FROM "ServiceBooking"
        WHERE "id" = ? AND "updatedAt" = ?
        ON CONFLICT("idempotencyKey") DO NOTHING
      `).bind(
        eventId, input.bookingId, timestamp, input.actorUserId,
        JSON.stringify({ requestFingerprint: input.requestFingerprint }),
        input.idempotencyKey, input.bookingId, timestamp,
      ),
      assertOneChange(d1),
    ]);
    const inspection = await db.inspection.findUnique({ where: { bookingId: input.bookingId } });
    if (!inspection) throw new Error("CARE inspection could not be loaded after D1 batch");
    return inspection;
  }

  try {
    return await db.$transaction(async (tx) => {
    await claimBookingPrisma(tx, input, now);
    const inspection = await tx.inspection.upsert({
      where: { bookingId: input.bookingId },
      create: {
        id: inspectionId,
        bookingId: input.bookingId,
        results: input.results,
        measurements: input.measurements,
        images: input.images,
        technicianNotes: input.technicianNotes,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        results: input.results,
        measurements: input.measurements,
        images: input.images,
        technicianNotes: input.technicianNotes,
        updatedAt: now,
      },
    });
    await tx.serviceTimelineEvent.create({
      data: {
        id: eventId,
        bookingId: input.bookingId,
        eventType: "inspection_started",
        actor: input.actorUserId,
        metadata: JSON.stringify({ requestFingerprint: input.requestFingerprint }),
        idempotencyKey: input.idempotencyKey,
        timestamp: now,
      },
    });
      return inspection;
    });
  } catch (error) {
    const replay = await findCareRecordReplay(db, input, "inspection");
    if (replay) return replay;
    throw error;
  }
}

export async function upsertCareHealthReportAtomically(db: PrismaClient, input: UpsertHealthReportInput) {
  const d1 = await getD1Binding();
  const reportId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = new Date();
  const replay = await findCareRecordReplay(db, input, "health-report");
  if (replay) return replay;

  const reportData = {
    overallScore: input.overallScore,
    engineScore: input.engineScore,
    oilScore: input.oilScore,
    brakeScore: input.brakeScore,
    batteryScore: input.batteryScore,
    tireScore: input.tireScore,
    filterScore: input.filterScore,
    fluidScore: input.fluidScore,
    coolingScore: input.coolingScore,
    beltScore: input.beltScore,
    leakScore: input.leakScore,
    diagnosticScore: input.diagnosticScore,
    categories: input.categories,
    evidence: input.evidence,
  };

  if (d1) {
    const timestamp = now.toISOString();
    const values = [
      input.overallScore, input.engineScore, input.oilScore, input.brakeScore,
      input.batteryScore, input.tireScore, input.filterScore, input.fluidScore,
      input.coolingScore, input.beltScore, input.leakScore, input.diagnosticScore,
      input.categories, input.evidence, input.actorUserId,
    ];
    await runD1CareBatch(db, input, d1, [
      ...await d1BookingClaim(db, d1, input, timestamp),
      d1.prepare(`
        INSERT INTO "VehicleHealthReport"
          ("id", "vehicleId", "bookingId", "overallScore", "engineScore", "oilScore",
           "brakeScore", "batteryScore", "tireScore", "filterScore", "fluidScore",
           "coolingScore", "beltScore", "leakScore", "diagnosticScore", "categories",
           "evidence", "technicianId", "createdAt")
        SELECT ?, b."vehicleId", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM "ServiceBooking" b
        WHERE b."id" = ? AND b."updatedAt" = ?
        ON CONFLICT("bookingId") DO UPDATE SET
          "overallScore" = excluded."overallScore",
          "engineScore" = excluded."engineScore",
          "oilScore" = excluded."oilScore",
          "brakeScore" = excluded."brakeScore",
          "batteryScore" = excluded."batteryScore",
          "tireScore" = excluded."tireScore",
          "filterScore" = excluded."filterScore",
          "fluidScore" = excluded."fluidScore",
          "coolingScore" = excluded."coolingScore",
          "beltScore" = excluded."beltScore",
          "leakScore" = excluded."leakScore",
          "diagnosticScore" = excluded."diagnosticScore",
          "categories" = excluded."categories",
          "evidence" = excluded."evidence"
      `).bind(
        reportId, input.bookingId, ...values, timestamp, input.bookingId, timestamp,
      ),
      assertOneChange(d1),
      d1.prepare(`
        INSERT INTO "VehicleCareProfile"
          ("id", "vehicleId", "healthScore", "createdAt", "updatedAt")
        SELECT ?, b."vehicleId", ?, ?, ?
        FROM "ServiceBooking" b
        WHERE b."id" = ? AND b."updatedAt" = ?
        ON CONFLICT("vehicleId") DO UPDATE SET
          "healthScore" = excluded."healthScore",
          "updatedAt" = excluded."updatedAt"
      `).bind(profileId, input.overallScore, timestamp, timestamp, input.bookingId, timestamp),
      assertOneChange(d1),
      d1.prepare(`
        INSERT INTO "ServiceTimelineEvent"
          ("id", "bookingId", "eventType", "timestamp", "actor", "metadata", "idempotencyKey")
        SELECT ?, ?, 'health_report_created', ?, ?, ?, ?
        FROM "ServiceBooking"
        WHERE "id" = ? AND "updatedAt" = ?
        ON CONFLICT("idempotencyKey") DO NOTHING
      `).bind(
        eventId, input.bookingId, timestamp, input.actorUserId,
        JSON.stringify({ requestFingerprint: input.requestFingerprint }),
        input.idempotencyKey, input.bookingId, timestamp,
      ),
      assertOneChange(d1),
    ]);
    const report = await db.vehicleHealthReport.findUnique({ where: { bookingId: input.bookingId } });
    if (!report) throw new Error("CARE health report could not be loaded after D1 batch");
    return report;
  }

  try {
    return await db.$transaction(async (tx) => {
    const booking = await claimBookingPrisma(tx, input, now);
    const report = await tx.vehicleHealthReport.upsert({
      where: { bookingId: input.bookingId },
      create: {
        id: reportId,
        vehicleId: booking.vehicleId,
        bookingId: input.bookingId,
        technicianId: input.actorUserId,
        ...reportData,
        createdAt: now,
      },
      update: reportData,
    });
    await tx.vehicleCareProfile.upsert({
      where: { vehicleId: booking.vehicleId },
      create: { id: profileId, vehicleId: booking.vehicleId, healthScore: input.overallScore },
      update: { healthScore: input.overallScore },
    });
    await tx.serviceTimelineEvent.create({
      data: {
        id: eventId,
        bookingId: input.bookingId,
        eventType: "health_report_created",
        actor: input.actorUserId,
        metadata: JSON.stringify({ requestFingerprint: input.requestFingerprint }),
        idempotencyKey: input.idempotencyKey,
        timestamp: now,
      },
    });
      return report;
    });
  } catch (error) {
    const replay = await findCareRecordReplay(db, input, "health-report");
    if (replay) return replay;
    throw error;
  }
}
