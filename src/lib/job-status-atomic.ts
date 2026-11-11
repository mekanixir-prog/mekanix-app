import type { JobStatus, PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";
import { multiplyRatioIrr } from "@/lib/money/irr";

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

export type AtomicInvoiceInput = {
  id: string;
  code: string;
  jobId: string;
  laborHours: number;
  laborRate: number;
  laborTotal: number;
  partsTotal: number;
  travelFee: number;
  inspectionFee: number;
  emergencyFee: number;
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  discount: number;
  total: number;
  currency: string;
  pricingVersion: string;
  financialUnitStatus: "VERIFIED_IRR";
  status: "SENT";
  notes: string;
};

export type AtomicJobStatusInput = {
  jobId: string;
  requestId: string;
  technicianId: string;
  actorRole: "TECHNICIAN" | "ADMIN" | "CUSTOMER" | "FLEET_MANAGER";
  actorTechnicianId: string | null;
  currentStatus: JobStatus;
  expectedUpdatedAt: Date;
  nextStatus: JobStatus;
  updates: JobStatusScalarUpdates;
  invoice?: AtomicInvoiceInput | null;
  holdUntil?: Date | null;
};

export type JobStatusActorRole = AtomicJobStatusInput["actorRole"] | "PARTNER";

const TECHNICIAN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  ACCEPTED: ["REQUESTED"],
  EN_ROUTE: ["ACCEPTED"],
  ARRIVED: ["EN_ROUTE", "ACCEPTED"],
  DIAGNOSING: ["ARRIVED", "EN_ROUTE", "ACCEPTED"],
  REPAIRING: ["DIAGNOSING", "WAITING_APPROVAL"],
  WAITING_APPROVAL: ["REPAIRING"],
  COMPLETED: ["REPAIRING"],
  REJECTED: ["REQUESTED"],
};

const CUSTOMER_CANCEL_FROM = ["REQUESTED", "ACCEPTED", "EN_ROUTE"] as const;

/**
 * Shared role matrix for both the HTTP route and the final Prisma/D1 write
 * boundary. ADMIN bypasses role-specific transitions deliberately, but the
 * atomic writer still enforces universal repair/estimate invariants.
 */
export function isAllowedJobStatusTransition(
  role: JobStatusActorRole,
  currentStatus: string,
  nextStatus: string,
  customerApproved: boolean | undefined,
): boolean {
  if (role === "ADMIN") return true;
  if (role === "PARTNER") return false;

  if (role === "CUSTOMER" || role === "FLEET_MANAGER") {
    if (customerApproved === true) {
      return currentStatus === "WAITING_APPROVAL" && nextStatus === currentStatus;
    }
    return nextStatus === "CANCELLED" &&
      CUSTOMER_CANCEL_FROM.includes(currentStatus as (typeof CUSTOMER_CANCEL_FROM)[number]);
  }

  return TECHNICIAN_TRANSITIONS[nextStatus]?.includes(currentStatus) ?? false;
}

function isRequestTerminalTransition(status: string) {
  return status === "CANCELLED" || status === "REJECTED";
}

function isTechnicianReleaseTransition(status: string) {
  return status === "COMPLETED" || isRequestTerminalTransition(status);
}

export function assertAtomicInvoiceInput(invoice: AtomicInvoiceInput, jobId: string): void {
  const moneyFields = [
    invoice.laborRate,
    invoice.laborTotal,
    invoice.partsTotal,
    invoice.travelFee,
    invoice.inspectionFee,
    invoice.emergencyFee,
    invoice.subtotal,
    invoice.taxTotal,
    invoice.discount,
    invoice.total,
  ];
  if (invoice.jobId !== jobId ||
      invoice.currency !== "IRR" ||
      invoice.financialUnitStatus !== "VERIFIED_IRR" ||
      invoice.status !== "SENT" ||
      !/^rate-card-\\d+$/.test(invoice.pricingVersion) ||
      typeof invoice.notes !== "string" ||
      !Number.isSafeInteger(invoice.laborHours) ||
      invoice.laborHours <= 0 ||
      !Number.isFinite(invoice.taxRate) ||
      invoice.taxRate < 0 || invoice.taxRate > 1 ||
      !Number.isSafeInteger(invoice.taxRate * 10_000) ||
      invoice.discount !== 0 ||
      moneyFields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new JobStatusConflictError();
  }

  const [laborRate, laborTotal, partsTotal, travelFee, inspectionFee, emergencyFee,
    subtotal, taxTotal, discount, total] = moneyFields;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const expectedLabor = BigInt(laborRate) * BigInt(invoice.laborHours);
  const expectedSubtotal = BigInt(laborTotal) + BigInt(partsTotal) +
    BigInt(travelFee) + BigInt(inspectionFee) + BigInt(emergencyFee);
  const expectedTotal = BigInt(subtotal) + BigInt(taxTotal) - BigInt(discount);
  const taxRateBps = invoice.taxRate * 10_000;

  if (expectedLabor > max || expectedSubtotal > max || expectedTotal > max ||
      expectedLabor !== BigInt(laborTotal) ||
      expectedSubtotal !== BigInt(subtotal) ||
      expectedTotal !== BigInt(total)) {
    throw new JobStatusConflictError();
  }

  // The persisted tax rate is an exact basis-point ratio. Tax remains disabled
  // by default; if enabled later, the writer still verifies the rounded IRR total.
  const expectedTax = multiplyRatioIrr(subtotal, taxRateBps, 10_000, "half-up");
  if (expectedTax !== taxTotal) {
    throw new JobStatusConflictError();
  }
}

function assertRoleTransition(input: AtomicJobStatusInput) {
  const estimateTransition = input.currentStatus === "REPAIRING" && input.nextStatus === "WAITING_APPROVAL";
  if (estimateTransition !== Boolean(input.invoice)) throw new JobStatusConflictError();
  if (input.invoice) assertAtomicInvoiceInput(input.invoice, input.jobId);
  const isCustomerActor = input.actorRole === "CUSTOMER" || input.actorRole === "FLEET_MANAGER";
  if (input.actorRole === "TECHNICIAN" &&
      (!input.actorTechnicianId || input.actorTechnicianId !== input.technicianId)) {
    throw new JobStatusConflictError();
  }
  if (input.updates.customerApproved !== undefined &&
      (!isCustomerActor || input.updates.customerApproved !== true)) {
    throw new JobStatusConflictError();
  }

  const updateKeys = Object.keys(input.updates);
  const approvalOnly =
    isCustomerActor &&
    input.currentStatus === "WAITING_APPROVAL" &&
    input.nextStatus === input.currentStatus &&
    input.updates.customerApproved === true &&
    updateKeys.every((key) => key === "customerApproved");

  if (!isAllowedJobStatusTransition(
    input.actorRole,
    input.currentStatus,
    input.nextStatus,
    input.updates.customerApproved,
  )) {
    throw new JobStatusConflictError();
  }

  if (input.actorRole === "TECHNICIAN" || input.actorRole === "ADMIN") {
    const allowedUpdates = new Set<string>(["technicianNotes"]);
    if (input.nextStatus === "ACCEPTED") allowedUpdates.add("startedAt");
    if (input.nextStatus === "ARRIVED") allowedUpdates.add("arrivedAt");
    if (input.nextStatus === "COMPLETED") allowedUpdates.add("completedAt");
    if (updateKeys.some((key) => !allowedUpdates.has(key))) {
      throw new JobStatusConflictError();
    }
  }

  // Universal lifecycle invariants apply even to ADMIN. The admin bypass is
  // limited to the role matrix; it cannot skip diagnosis, repair, or consent.
  if (input.nextStatus === "COMPLETED" && input.currentStatus !== "REPAIRING") {
    throw new JobStatusConflictError();
  }
  // REPAIRING without an invoice is the pre-estimate parts-preparation stage;
  // REPAIRING after customer approval is the actual repair stage.
  if (input.nextStatus === "REPAIRING" && !["DIAGNOSING", "WAITING_APPROVAL"].includes(input.currentStatus)) {
    throw new JobStatusConflictError();
  }
  if (input.nextStatus === "WAITING_APPROVAL" && input.currentStatus !== "REPAIRING" && !approvalOnly) {
    throw new JobStatusConflictError();
  }
  if (isCustomerActor && input.nextStatus === "CANCELLED" && updateKeys.length !== 0) {
    throw new JobStatusConflictError();
  }
}

async function transitionWithPrisma(db: PrismaClient, input: AtomicJobStatusInput) {
  await db.$transaction(async (tx) => {
    const requestTransition = isRequestTerminalTransition(input.nextStatus);
    const jobWhere: any = {
      id: input.jobId,
      status: input.currentStatus,
      updatedAt: input.expectedUpdatedAt,
    };
    if (input.actorRole === "TECHNICIAN") {
      if (!input.actorTechnicianId) throw new JobStatusConflictError();
      jobWhere.technicianId = input.actorTechnicianId;
    }
    if (input.currentStatus === "WAITING_APPROVAL" && input.nextStatus === "REPAIRING") {
      jobWhere.customerApproved = true;
    }
    if (requestTransition) {
      jobWhere.request = {
        is: { id: input.requestId, matchedTechId: input.technicianId },
      };
    }

    const jobData = {
      status: input.nextStatus,
      ...(input.nextStatus === "WAITING_APPROVAL" && input.currentStatus !== "WAITING_APPROVAL"
        ? { customerApproved: false }
        : {}),
      ...input.updates,
    };
    const jobUpdate = await tx.job.updateMany({
      where: jobWhere,
      data: jobData,
    });
    if (jobUpdate.count !== 1) throw new JobStatusConflictError();

    if (input.invoice) {
      await tx.invoice.create({ data: input.invoice });
    }
    if (input.holdUntil) {
      await tx.walletTransaction.updateMany({
        where: { jobId: input.jobId, status: "PENDING" },
        data: { holdUntil: input.holdUntil },
      });
    }

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

  if (input.nextStatus === "WAITING_APPROVAL" && input.currentStatus !== "WAITING_APPROVAL") {
    assignments.push('"customerApproved" = ?');
    values.push(0);
  }
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
  let approvalGuard = "";
  values.push(input.jobId, input.currentStatus, input.expectedUpdatedAt.toISOString());
  if (input.actorRole === "TECHNICIAN") {
    if (!input.actorTechnicianId) throw new JobStatusConflictError();
    technicianGuard = ' AND "technicianId" = ?';
    values.push(input.actorTechnicianId);
  }
  if (input.currentStatus === "WAITING_APPROVAL" && input.nextStatus === "REPAIRING") {
    approvalGuard = ' AND "customerApproved" = 1';
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
      ' WHERE "id" = ? AND "status" = ? AND "updatedAt" = ?' + technicianGuard + approvalGuard + requestGuard
    ).bind(...values),
    assertOneChange(),
  ];

  if (input.holdUntil) {
    statements.push(d1.prepare(
      'UPDATE "WalletTransaction" SET "holdUntil" = ? WHERE "jobId" = ? AND "status" = \'PENDING\''
    ).bind(input.holdUntil.toISOString(), input.jobId));
  }

  if (input.invoice) {
    const invoice = input.invoice;
    statements.push(
      d1.prepare(
        'INSERT INTO "Invoice"' +
        ' ("id", "code", "jobId", "laborHours", "laborRate", "laborTotal", "partsTotal",' +
        ' "travelFee", "inspectionFee", "emergencyFee", "subtotal", "taxRate", "taxTotal", "discount", "total", "currency",' +
        ' "pricingVersion", "financialUnitStatus", "status", "notes", "createdAt", "updatedAt")' +
        ' SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?' +
        ' WHERE EXISTS (SELECT 1 FROM "Job" j WHERE j."id" = ? AND j."status" = ?)' +
        ' AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."jobId" = ?)'
      ).bind(
        invoice.id,
        invoice.code,
        invoice.jobId,
        invoice.laborHours,
        invoice.laborRate,
        invoice.laborTotal,
        invoice.partsTotal,
        invoice.travelFee,
        invoice.inspectionFee,
        invoice.emergencyFee,
        invoice.subtotal,
        invoice.taxRate,
        invoice.taxTotal,
        invoice.discount,
        invoice.total,
        invoice.currency,
        invoice.pricingVersion,
        invoice.financialUnitStatus,
        invoice.status,
        invoice.notes,
        now,
        now,
        input.jobId,
        input.nextStatus,
        input.jobId,
      ),
      assertOneChange(),
    );
  }

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
  assertRoleTransition(input);
  const d1 = await getD1Binding();
  if (d1) return transitionWithD1(d1, input);
  return transitionWithPrisma(db, input);
}
