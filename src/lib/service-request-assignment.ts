import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

export class ServiceRequestAssignmentConflictError extends Error {
  constructor() {
    super("Service request or technician is no longer available for assignment");
    this.name = "ServiceRequestAssignmentConflictError";
  }
}

export type AssignServiceRequestInput = {
  requestId: string;
  technicianId: string;
  category: string;
  etaMins: number;
};

async function assignWithPrisma(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  await db.$transaction(async (tx) => {
    // Claim the request first with compare-and-set semantics. A competing
    // customer/admin request can only win this OPEN + unassigned transition once.
    const requestClaim = await tx.serviceRequest.updateMany({
      where: {
        id: input.requestId,
        status: "OPEN",
        matchedTechId: null,
        job: { is: null },
      },
      data: {
        status: "ASSIGNED",
        matchedTechId: input.technicianId,
      },
    });
    if (requestClaim.count !== 1) {
      throw new ServiceRequestAssignmentConflictError();
    }

    // Claim the technician in the same transaction. If another request has
    // already taken the technician, throwing rolls back the request claim too.
    const technicianClaim = await tx.technician.updateMany({
      where: {
        id: input.technicianId,
        status: "ONLINE",
        verified: true,
        availableNow: true,
        user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
        specialties: { some: { category: input.category } },
      },
      data: { status: "ON_JOB" },
    });
    if (technicianClaim.count !== 1) {
      throw new ServiceRequestAssignmentConflictError();
    }

    await tx.job.create({
      data: {
        code: `JOB-${crypto.randomUUID().toUpperCase()}`,
        requestId: input.requestId,
        technicianId: input.technicianId,
        status: "REQUESTED",
        etaMins: input.etaMins,
      },
    });
  });
}

async function assignWithD1(
  db: PrismaClient,
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: AssignServiceRequestInput,
): Promise<void> {
  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const jobCode = `JOB-${crypto.randomUUID().toUpperCase()}`;

  // D1 batch is one atomic transaction. Every statement is conditional on the
  // preceding claim, so no request, technician, or job can be half-assigned.
  const results = await d1.batch([
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Job" WHERE "requestId" = "ServiceRequest"."id")
        AND EXISTS (
          SELECT 1
          FROM "Technician" t
          INNER JOIN "User" u ON u."id" = t."userId"
          WHERE t."id" = ?
            AND t."status" = 'ONLINE'
            AND t."verified" = 1
            AND t."availableNow" = 1
            AND u."status" = 'ACTIVE'
            AND u."role" = 'TECHNICIAN'
            AND EXISTS (
              SELECT 1 FROM "TechnicianSpecialty" s
              WHERE s."technicianId" = t."id" AND s."category" = ?
            )
        )
    `).bind(input.technicianId, now, input.requestId, input.technicianId, input.category),
    d1.prepare(`
      UPDATE "Technician"
      SET "status" = 'ON_JOB', "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'ONLINE'
        AND "verified" = 1 AND "availableNow" = 1
        AND EXISTS (
          SELECT 1 FROM "User" u
          WHERE u."id" = "Technician"."userId"
            AND u."status" = 'ACTIVE' AND u."role" = 'TECHNICIAN'
        )
        AND EXISTS (
          SELECT 1 FROM "TechnicianSpecialty" s
          WHERE s."technicianId" = "Technician"."id" AND s."category" = ?
        )
        AND EXISTS (
          SELECT 1 FROM "ServiceRequest" r
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ?
        )
    `).bind(now, input.technicianId, input.category, input.requestId, input.technicianId),
    d1.prepare(`
      INSERT INTO "Job"
        ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
      SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
      FROM "ServiceRequest" r
      INNER JOIN "Technician" t ON t."id" = ?
      WHERE r."id" = ? AND r."status" = 'ASSIGNED'
        AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
        AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
    `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
  ]);

  if (
    (results[0]?.meta?.changes ?? 0) !== 1 ||
    (results[1]?.meta?.changes ?? 0) !== 1 ||
    (results[2]?.meta?.changes ?? 0) !== 1
  ) {
    throw new ServiceRequestAssignmentConflictError();
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
