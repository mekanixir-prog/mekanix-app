import type { JobStatus, PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

export class JobStatusConflictError extends Error {
  constructor() {
    super("The job or linked service request changed before this transition could commit");
    this.name = "JobStatusConflictError";
  }
}

export type JobStatusScalarUpdates = {
  startedAt?: Date;
  arrivedAt?: Date;
  completedAt?: Date;
  technicianNotes?: string;
  customerApproved?: boolean;
};

export type AtomicJobStatusInput = {
  jobId: string;
  requestId: string;
  technicianId: string;
  currentStatus: JobStatus;
  nextStatus: JobStatus;
  updates: JobStatusScalarUpdates;
};

function isRequestTerminalTransition(status: string) {
  return status === "CANCELLED" || status === "REJECTED";
}

function isTechnicianReleaseTransition(status: string) {
  return status === "COMPLETED" || isRequestTerminalTransition(status);
}

async function transitionWithPrisma(db: PrismaClient, input: AtomicJobStatusInput) {
  await db.$transaction(async (tx) => {
    const requestTransition = isRequestTerminalTransition(input.nextStatus);
    const jobWhere: any = {
      id: input.jobId,
      status: input.currentStatus,
    };
    if (requestTransition) {
      jobWhere.request = {
        is: { id: input.requestId, matchedTechId: input.technicianId },
      };
    }

    const jobUpdate = await tx.job.updateMany({
      where: jobWhere,
      data: { status: input.nextStatus, ...input.updates },
    });
    if (jobUpdate.count !== 1) throw new JobStatusConflictError();

    if (requestTransition) {
      const requestUpdate = await tx.serviceRequest.updateMany({
        where: { id: input.requestId, matchedTechId: input.technicianId },
        data: input.nextStatus === "REJECTED"
          ? { status: "OPEN", matchedTechId: null }
          : { status: "CANCELLED" },
      });
      if (requestUpdate.count !== 1) throw new JobStatusConflictError();
    }

    if (isTechnicianReleaseTransition(input.nextStatus)) {
      await tx.technician.updateMany({
        where: {
          id: input.technicianId,
          status: "ON_JOB",
          jobsAssigned: {
            none: {
              status: {
                in: [
                  "REQUESTED", "ACCEPTED", "EN_ROUTE", "ARRIVED",
                  "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL",
                ],
              },
            },
          },
        },
        data: { status: "ONLINE" },
      });
    }
  });
}

async function transitionWithD1(
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: AtomicJobStatusInput,
) {
  const now = new Date().toISOString();
  const assignments = ['"status" = ?', '"updatedAt" = ?'];
  const values: unknown[] = [input.nextStatus, now];

  if (input.updates.startedAt) {
    assignments.push('"startedAt" = ?');
    values.push(input.updates.startedAt.toISOString());
  }
  if (input.updates.arrivedAt) {
    assignments.push('"arrivedAt" = ?');
    values.push(input.updates.arrivedAt.toISOString());
  }
  if (input.updates.completedAt) {
    assignments.push('"completedAt" = ?');
    values.push(input.updates.completedAt.toISOString());
  }
  if (input.updates.technicianNotes !== undefined) {
    assignments.push('"technicianNotes" = ?');
    values.push(input.updates.technicianNotes);
  }
  if (input.updates.customerApproved !== undefined) {
    assignments.push('"customerApproved" = ?');
    values.push(input.updates.customerApproved ? 1 : 0);
  }

  let requestGuard = "";
  values.push(input.jobId, input.currentStatus);
  if (isRequestTerminalTransition(input.nextStatus)) {
    requestGuard = `
      AND EXISTS (
        SELECT 1 FROM "ServiceRequest" r
        WHERE r."id" = ? AND r."matchedTechId" = ?
      )
    `;
    values.push(input.requestId, input.technicianId);
  }

  const statements = [
    d1.prepare(`
      UPDATE "Job"
      SET ${assignments.join(", ")}
      WHERE "id" = ? AND "status" = ?
      ${requestGuard}
    `).bind(...values),
  ];

  if (isRequestTerminalTransition(input.nextStatus)) {
    statements.push(d1.prepare(`
      UPDATE "ServiceRequest"
      SET "status" = ?, "matchedTechId" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "matchedTechId" = ?
        AND EXISTS (
          SELECT 1 FROM "Job" j
          WHERE j."id" = ? AND j."status" = ?
        )
    `).bind(
      input.nextStatus === "REJECTED" ? "OPEN" : "CANCELLED",
      input.nextStatus === "REJECTED" ? null : input.technicianId,
      now,
      input.requestId,
      input.technicianId,
      input.jobId,
      input.nextStatus,
    ));
  }

  if (isTechnicianReleaseTransition(input.nextStatus)) {
    statements.push(d1.prepare(`
      UPDATE "Technician"
      SET "status" = 'ONLINE', "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'ON_JOB'
        AND NOT EXISTS (
          SELECT 1 FROM "Job" j
          WHERE j."technicianId" = "Technician"."id"
            AND j."status" IN (
              'REQUESTED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED',
              'DIAGNOSING', 'REPAIRING', 'WAITING_APPROVAL'
            )
        )
    `).bind(now, input.technicianId));
  }

  const results = await d1.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new JobStatusConflictError();
  }
  if (isRequestTerminalTransition(input.nextStatus) &&
      (results[1]?.meta?.changes ?? 0) !== 1) {
    throw new JobStatusConflictError();
  }

  // D1 batch is the transaction boundary. The route reloads the job with
  // its relations after the commit.
}

export async function transitionJobStatusAtomically(
  db: PrismaClient,
  input: AtomicJobStatusInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return transitionWithD1(d1, input);
  return transitionWithPrisma(db, input);
}
