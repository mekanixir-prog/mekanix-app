import type { PrismaClient } from "@prisma/client";

type TransitionInput = {
  bookingId: string;
  expectedStatus: string;
  expectedUpdatedAt: Date;
  nextStatus: string;
  technicianId: string | null;
  actorId: string;
};

type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
};

type DbWithCareModels = PrismaClient & {
  serviceBooking: {
    updateMany(args: any): Promise<{ count: number }>;
    findUnique(args: any): Promise<any>;
  };
  serviceTimelineEvent: { create(args: any): Promise<any> };
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

const assertOneChange = (d1: D1Database) =>
  d1.prepare(
    "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END"
  ).bind();

/**
 * Updates a CARE mission and writes its audit timeline as one database
 * transaction in both Prisma/PostgreSQL and Cloudflare D1.
 */
export async function recordCareStatusTransition(
  db: DbWithCareModels,
  input: TransitionInput
): Promise<any | null> {
  const updatedAt = new Date();
  const transitionKey =
    `care-status:${input.bookingId}:${input.expectedUpdatedAt.toISOString()}:${input.nextStatus}`;

  const isCloudflareWorkers =
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";

  if (isCloudflareWorkers) {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const d1 = (context.env as unknown as { DB?: D1Database }).DB;
    if (!d1) throw new Error("D1 binding 'DB' is unavailable for CARE status transition");

    const ownershipClause = input.technicianId ? ' AND "technicianId" = ?' : "";
    const updateValues: unknown[] = [
      input.nextStatus,
      updatedAt.toISOString(),
      input.bookingId,
      input.expectedStatus,
      input.expectedUpdatedAt.toISOString(),
    ];
    if (input.technicianId) updateValues.push(input.technicianId);

    await d1.batch([
      d1.prepare(
        'UPDATE "ServiceBooking" SET "status" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ? AND "updatedAt" = ?' +
        ownershipClause
      ).bind(...updateValues),
      assertOneChange(d1),
      d1.prepare(
        'INSERT INTO "ServiceTimelineEvent" ' +
        '("id", "bookingId", "eventType", "timestamp", "actor", "idempotencyKey") ' +
        'SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (' +
        'SELECT 1 FROM "ServiceBooking" WHERE "id" = ? AND "status" = ? AND "updatedAt" = ?' +
        ')'
      ).bind(
        crypto.randomUUID(),
        input.bookingId,
        input.nextStatus.toLowerCase(),
        updatedAt.toISOString(),
        input.actorId,
        transitionKey,
        input.bookingId,
        input.nextStatus,
        updatedAt.toISOString()
      ),
      assertOneChange(d1),
    ]);

    return db.serviceBooking.findUnique({ where: { id: input.bookingId } });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.serviceBooking.updateMany({
      where: {
        id: input.bookingId,
        status: input.expectedStatus,
        updatedAt: input.expectedUpdatedAt,
        ...(input.technicianId ? { technicianId: input.technicianId } : {}),
      },
      data: { status: input.nextStatus, updatedAt },
    });
    if (updated.count !== 1) return null;

    await tx.serviceTimelineEvent.create({
      data: {
        bookingId: input.bookingId,
        eventType: input.nextStatus.toLowerCase(),
        actor: input.actorId,
        timestamp: updatedAt,
        idempotencyKey: transitionKey,
      },
    });

    return tx.serviceBooking.findUnique({ where: { id: input.bookingId } });
  });
}
