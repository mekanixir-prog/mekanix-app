import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

export class JobPartMutationConflictError extends Error {
  constructor() {
    super("Parts are editable only while the job is REPAIRING and before an invoice exists");
    this.name = "JobPartMutationConflictError";
  }
}

export class JobPartNotFoundError extends Error {
  constructor() {
    super("The part does not belong to this job");
    this.name = "JobPartNotFoundError";
  }
}

export type NewJobPart = {
  jobId: string;
  name: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
};

function assertOneChange(d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>) {
  return d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
}

function nextJobRevision(updatedAt: Date | string): Date {
  const previous = new Date(updatedAt).getTime();
  if (!Number.isFinite(previous)) throw new JobPartMutationConflictError();
  // Keep the revision strictly monotonic even if two writes occur in one millisecond.
  return new Date(Math.max(Date.now(), previous + 1));
}

function isD1Conflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed json|not-json/i.test(message);
}

/**
 * Serialize part edits against the REPAIRING -> WAITING_APPROVAL transition.
 * The invoice is created in that transition, so a part cannot silently change
 * after the fixed-fee estimate has been issued.
 */
export async function addJobPartBeforeInvoice(db: PrismaClient, input: NewJobPart) {
  const id = crypto.randomUUID();
  const d1 = await getD1Binding();

  if (d1) {
    const current = await db.job.findUnique({
      where: { id: input.jobId },
      select: { status: true, updatedAt: true },
    });
    if (!current || current.status !== "REPAIRING") throw new JobPartMutationConflictError();
    const nextUpdatedAt = nextJobRevision(current.updatedAt);
    const previousUpdatedAt = new Date(current.updatedAt).toISOString();
    const nextUpdatedAtIso = nextUpdatedAt.toISOString();
    const touchJob = d1.prepare(
      'UPDATE "Job" SET "updatedAt" = ? WHERE "id" = ? AND "status" = \'REPAIRING\' AND "updatedAt" = ?' +
      ' AND NOT EXISTS (SELECT 1 FROM "Invoice" WHERE "jobId" = ?)'
    ).bind(nextUpdatedAtIso, input.jobId, previousUpdatedAt, input.jobId);
    const insertPart = d1.prepare(
      'INSERT INTO "Part" ("id", "jobId", "name", "sku", "quantity", "unitPrice", "financialUnitStatus", "createdAt")' +
      ' SELECT ?, ?, ?, ?, ?, ?, ?, ?' +
      ' WHERE EXISTS (SELECT 1 FROM "Job" WHERE "id" = ? AND "status" = \'REPAIRING\' AND "updatedAt" = ?)' +
      ' AND NOT EXISTS (SELECT 1 FROM "Invoice" WHERE "jobId" = ?)'
    ).bind(id, input.jobId, input.name, input.sku, input.quantity, input.unitPrice, "VERIFIED_IRR", nextUpdatedAtIso, input.jobId, nextUpdatedAtIso, input.jobId);
    try {
      await d1.batch([touchJob, assertOneChange(d1), insertPart, assertOneChange(d1)]);
    } catch (error) {
      if (isD1Conflict(error)) throw new JobPartMutationConflictError();
      throw error;
    }
    const created = await db.part.findUnique({ where: { id } });
    if (!created) throw new JobPartMutationConflictError();
    return created;
  }

  return db.$transaction(async (tx) => {
    const current = await tx.job.findUnique({
      where: { id: input.jobId },
      select: { status: true, updatedAt: true },
    });
    if (!current || current.status !== "REPAIRING") throw new JobPartMutationConflictError();
    const nextUpdatedAt = nextJobRevision(current.updatedAt);
    const lock = await tx.job.updateMany({
      where: { id: input.jobId, status: "REPAIRING", updatedAt: current.updatedAt },
      data: { updatedAt: nextUpdatedAt },
    });
    if (lock.count !== 1) throw new JobPartMutationConflictError();
    const invoice = await tx.invoice.findUnique({ where: { jobId: input.jobId }, select: { id: true } });
    if (invoice) throw new JobPartMutationConflictError();
    return tx.part.create({
      data: {
        id,
        jobId: input.jobId,
        name: input.name,
        sku: input.sku,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
  });
}

export async function removeJobPartBeforeInvoice(db: PrismaClient, jobId: string, partId: string) {
  const d1 = await getD1Binding();
  if (d1) {
    const current = await db.job.findUnique({
      where: { id: jobId },
      select: { status: true, updatedAt: true },
    });
    if (!current || current.status !== "REPAIRING") throw new JobPartMutationConflictError();
    const nextUpdatedAt = nextJobRevision(current.updatedAt).toISOString();
    const previousUpdatedAt = new Date(current.updatedAt).toISOString();
    const touchJob = d1.prepare(
      'UPDATE "Job" SET "updatedAt" = ? WHERE "id" = ? AND "status" = \'REPAIRING\' AND "updatedAt" = ?' +
      ' AND NOT EXISTS (SELECT 1 FROM "Invoice" WHERE "jobId" = ?)'
    ).bind(nextUpdatedAt, jobId, previousUpdatedAt, jobId);
    const deletePart = d1.prepare(
      'DELETE FROM "Part" WHERE "id" = ? AND "jobId" = ?' +
      ' AND EXISTS (SELECT 1 FROM "Job" WHERE "id" = ? AND "status" = \'REPAIRING\' AND "updatedAt" = ?)' +
      ' AND NOT EXISTS (SELECT 1 FROM "Invoice" WHERE "jobId" = ?)'
    ).bind(partId, jobId, jobId, nextUpdatedAt, jobId);
    try {
      await d1.batch([touchJob, assertOneChange(d1), deletePart, assertOneChange(d1)]);
    } catch (error) {
      if (isD1Conflict(error)) throw new JobPartMutationConflictError();
      throw error;
    }
    return;
  }

  await db.$transaction(async (tx) => {
    const current = await tx.job.findUnique({
      where: { id: jobId },
      select: { status: true, updatedAt: true },
    });
    if (!current || current.status !== "REPAIRING") throw new JobPartMutationConflictError();
    const nextUpdatedAt = nextJobRevision(current.updatedAt);
    const lock = await tx.job.updateMany({
      where: { id: jobId, status: "REPAIRING", updatedAt: current.updatedAt },
      data: { updatedAt: nextUpdatedAt },
    });
    if (lock.count !== 1) throw new JobPartMutationConflictError();
    const invoice = await tx.invoice.findUnique({ where: { jobId }, select: { id: true } });
    if (invoice) throw new JobPartMutationConflictError();
    const part = await tx.part.findUnique({ where: { id: partId }, select: { jobId: true } });
    if (!part || part.jobId !== jobId) throw new JobPartNotFoundError();
    await tx.part.delete({ where: { id: partId } });
  });
}
