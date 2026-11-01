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
  existingRejectedJobId: string | null;
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
        job: input.existingRejectedJobId
          ? { is: { id: input.existingRejectedJobId, status: "REJECTED" } }
          : { is: null },
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

    if (input.existingRejectedJobId) {
      const reassignment = await tx.job.updateMany({
        where: {
          id: input.existingRejectedJobId,
          requestId: input.requestId,
          status: "REJECTED",
        },
        data: {
          technicianId: input.technicianId,
          status: "REQUESTED",
          etaMins: input.etaMins,
          customerApproved: false,
          startedAt: null,
          arrivedAt: null,
          completedAt: null,
          diagnosis: null,
          technicianNotes: null,
          replacedParts: null,
        },
      });
      if (reassignment.count !== 1) {
        throw new ServiceRequestAssignmentConflictError();
      }
    } else {
      await tx.job.create({
        data: {
          code: `JOB-${crypto.randomUUID().toUpperCase()}`,
          requestId: input.requestId,
          technicianId: input.technicianId,
          status: "REQUESTED",
          etaMins: input.etaMins,
        },
      });
    }
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

  // A zero-row statement does not abort D1.batch. Force a SQL error after
  // every compare-and-set unless exactly one row changed, so D1 rolls back
  // the entire batch instead of committing a partial assignment.
  const assertOneChange = () =>
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`).bind();

  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END").bind();
  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`).bind();

  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END").bind();          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`).bind();

  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END").bind();          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`).bind();

  const statements = [
    d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = 'ASSIGNED', "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'OPEN' AND "matchedTechId" IS NULL
        AND ${input.existingRejectedJobId
          ? 'EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."requestId" = "ServiceRequest"."id" AND j."status" = \'REJECTED\')'
          : 'NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = "ServiceRequest"."id")'}
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
    `).bind(
      input.technicianId,
      now,
      input.requestId,
      ...(input.existingRejectedJobId ? [input.existingRejectedJobId] : []),
      input.technicianId,
      input.category,
    ),
    assertOneChange(),
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
    assertOneChange(),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
          INSERT INTO "Job"
            ("id", "code", "requestId", "technicianId", "status", "etaMins", "createdAt", "updatedAt")
          SELECT ?, ?, r."id", t."id", 'REQUESTED', ?, ?, ?
          FROM "ServiceRequest" r
          INNER JOIN "Technician" t ON t."id" = ?
          WHERE r."id" = ? AND r."status" = 'ASSIGNED'
            AND r."matchedTechId" = ? AND t."status" = 'ON_JOB'
            AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."requestId" = r."id")
        `).bind(jobId, jobCode, input.etaMins, now, now, input.technicianId, input.requestId, input.technicianId),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END").bind();          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`));

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new ServiceRequestAssignmentConflictError();
    }
    throw error;
  }

  // Keep Prisma's view as the common post-commit verification for both D1 and
  // local SQLite/PostgreSQL execution paths.
  const job = await db.job.findUnique({ where: { requestId: input.requestId }, select: { id: true } });
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END").bind();          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
) END`),
    input.existingRejectedJobId
      ? d1.prepare(`
          UPDATE "Job"
          SET "technicianId" = ?, "status" = 'REQUESTED', "etaMins" = ?,
              "customerApproved" = 0, "startedAt" = NULL, "arrivedAt" = NULL,
              "completedAt" = NULL, "diagnosis" = NULL, "technicianNotes" = NULL,
              "replacedParts" = NULL, "updatedAt" = ?
          WHERE "id" = ? AND "requestId" = ? AND "status" = 'REJECTED'
            AND EXISTS (
              SELECT 1 FROM "ServiceRequest" r
              WHERE r."id" = ? AND r."status" = 'ASSIGNED'
                AND r."matchedTechId" = ?
            )
            AND EXISTS (
              SELECT 1 FROM "Technician" t
              WHERE t."id" = ? AND t."status" = 'ON_JOB'
            )
        `).bind(
          input.technicianId,
          input.etaMins,
          now,
          input.existingRejectedJobId,
          input.requestId,
          input.requestId,
          input.technicianId,
          input.technicianId,
        )
      : d1.prepare(`
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
  if (!job) throw new Error("Assignment transaction committed without creating or reassigning its job");
}

export async function assignServiceRequestAtomically(
  db: PrismaClient,
  input: AssignServiceRequestInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return assignWithD1(db, d1, input);
  return assignWithPrisma(db, input);
}
