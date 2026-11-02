import type { JobStatus, PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

export class JobStatusConflictError extends Error {
  constructor() {
    super("The job, technician assignment, or linked service request changed before this transition could commit");
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
  actorRole: "TECHNICIAN" | "ADMIN" | "CUSTOMER" | "FLEET_MANAGER";
  actorTechnicianId: string | null;
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
    if (input.actorRole === "TECHNICIAN") {
      if (!input.actorTechnicianId) throw new JobStatusConflictError();
      jobWhere.technicianId = input.actorTechnicianId;
    }
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

  let technicianGuard = "";
  let requestGuard = "";
  values.push(input.jobId, input.currentStatus);
  if (input.actorRole === "TECHNICIAN") {
    if (!input.actorTechnicianId) throw new JobStatusConflictError();
    technicianGuard = ' AND "technicianId" = ?';
    values.push(input.actorTechnicianId);
  }
  if (isRequestTerminalTransition(input.nextStatus)) {
    requestGuard = ' AND EXISTS (SELECT 1 FROM "ServiceRequest" r WHERE r."id" = ? AND r."matchedTechId" = ?)';
    values.push(input.requestId, input.technicianId);
  }

  // A zero-row CAS does not abort D1.batch by itself. The assertion is part
  // of the same batch, so a failed required write rolls back the full batch.
  const assertOneChange = () =>
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();

  const statements = [
    d1.prepare(
      'UPDATE "Job" SET ' + assignments.join(", ") +
      ' WHERE "id" = ? AND "status" = ?' + technicianGuard + requestGuard
    ).bind(...values),
    assertOneChange(),
  ];

  if (isRequestTerminalTransition(input.nextStatus)) {
    statements.push(
      d1.prepare(
        'UPDATE "ServiceRequest" SET "status" = ?, "matchedTechId" = ?, "updatedAt" = ?' +
        ' WHERE "id" = ? AND "matchedTechId" = ?' +
        ' AND EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."status" = ?)'
      ).bind(
        input.nextStatus === "REJECTED" ? "OPEN" : "CANCELLED",
        input.nextStatus === "REJECTED" ? null : input.technicianId,
        now,
        input.requestId,
        input.technicianId,
        input.jobId,
        input.nextStatus,
      ),
      assertOneChange(),
    );
  }

  if (isTechnicianReleaseTransition(input.nextStatus)) {
    statements.push(d1.prepare(
      'UPDATE "Technician" SET "status" = \'ONLINE\', "updatedAt" = ?' +
      ' WHERE "id" = ? AND "status" = \'ON_JOB\'' +
      ' AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."technicianId" = "Technician"."id"' +
      ' AND j."status" IN (\'REQUESTED\', \'ACCEPTED\', \'EN_ROUTE\', \'ARRIVED\',' +
      ' \'DIAGNOSING\', \'REPAIRING\', \'WAITING_APPROVAL\'))'
    ).bind(now, input.technicianId));
  }

  try {
    await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new JobStatusConflictError();
    }
    throw error;
  }
}

export async function transitionJobStatusAtomically(
  db: PrismaClient,
  input: AtomicJobStatusInput,
): Promise<void> {
  const d1 = await getD1Binding();
  if (d1) return transitionWithD1(d1, input);
  return transitionWithPrisma(db, input);
}
