import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";
import type { ExtraProposalInput } from "@/lib/care-extra-pricing";

export class CareExtraProposalConflictError extends Error {
  constructor() {
    super("The booking or linked finding changed before the proposal could be committed");
    this.name = "CareExtraProposalConflictError";
  }
}

export type CareExtraProposalDetails = {
  description: string | null;
  partName: string | null;
  partBrand: string | null;
  partNumber: string | null;
  partType: string;
  imageUrl: string | null;
  technicianNote: string | null;
};

export type CareExtraFindingInput = {
  category: string;
  title: string;
  description: string | null;
  severity: string;
};

export type CreateCareExtraProposalInput = {
  bookingId: string;
  expectedBookingStatus: "INSPECTING" | "IN_SERVICE";
  actorUserId: string;
  proposal: ExtraProposalInput;
  details: CareExtraProposalDetails;
  newFinding: CareExtraFindingInput | null;
};

async function createWithPrisma(db: PrismaClient, input: CreateCareExtraProposalInput) {
  return db.$transaction(async (tx) => {
    const bookingClaim = await tx.serviceBooking.updateMany({
      where: { id: input.bookingId, status: input.expectedBookingStatus },
      data: { status: "WAITING_CUSTOMER_APPROVAL", updatedAt: new Date() },
    });
    if (bookingClaim.count !== 1) throw new CareExtraProposalConflictError();

    let findingId = input.proposal.findingId;
    if (findingId) {
      const finding = await tx.finding.findFirst({
        where: { id: findingId, bookingId: input.bookingId },
        select: { id: true },
      });
      if (!finding) throw new CareExtraProposalConflictError();
    } else if (input.newFinding) {
      const finding = await tx.finding.create({
        data: {
          bookingId: input.bookingId,
          ...input.newFinding,
        },
        select: { id: true },
      });
      findingId = finding.id;
    }

    const totalPrice =
      input.proposal.partPrice * input.proposal.quantity + input.proposal.laborPrice;
    const approval = await tx.customerApproval.create({
      data: {
        bookingId: input.bookingId,
        findingId,
        proposedItem: input.proposal.proposedItem,
        description: input.details.description,
        partName: input.details.partName,
        partBrand: input.details.partBrand,
        partNumber: input.details.partNumber,
        partType: input.details.partType,
        quantity: input.proposal.quantity,
        partPrice: input.proposal.partPrice,
        laborPrice: input.proposal.laborPrice,
        totalPrice,
        imageUrl: input.details.imageUrl,
        technicianNote: input.details.technicianNote,
        status: "PROPOSED",
      },
    });

    await tx.serviceTimelineEvent.create({
      data: {
        bookingId: input.bookingId,
        eventType: "extra_proposal",
        actor: input.actorUserId,
        metadata: JSON.stringify({ approvalId: approval.id }),
      },
    });
    return approval;
  });
}

async function createWithD1(
  db: PrismaClient,
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: CreateCareExtraProposalInput,
) {
  const now = new Date().toISOString();
  const approvalId = crypto.randomUUID();
  const timelineId = crypto.randomUUID();
  const findingId = input.proposal.findingId ?? (input.newFinding ? crypto.randomUUID() : null);
  const totalPrice =
    input.proposal.partPrice * input.proposal.quantity + input.proposal.laborPrice;

  const findingGuard = input.proposal.findingId
    ? 'AND EXISTS (SELECT 1 FROM "Finding" f WHERE f."id" = ? AND f."bookingId" = ?)'
    : "";
  const bookingBindings: unknown[] = [
    "WAITING_CUSTOMER_APPROVAL",
    now,
    input.bookingId,
    input.expectedBookingStatus,
  ];
  if (input.proposal.findingId) {
    bookingBindings.push(input.proposal.findingId, input.bookingId);
  }

  const findingGuard = input.proposal.findingId
    ? 'AND EXISTS (SELECT 1 FROM "Finding" f WHERE f."id" = ? AND f."bookingId" = ?)'
    : "";
  const timelineBindings: unknown[] = [
    timelineId,
    input.bookingId,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId }),
    `extra-proposal:${approvalId}`,
    input.bookingId,
    input.expectedBookingStatus,
  ];
  if (input.proposal.findingId) {
    timelineBindings.push(input.proposal.findingId, input.bookingId);
  }

  // The first insert is a transaction marker and the timeline event itself.
  // Every later statement is gated by this unique event ID. A stale second
  // proposal therefore cannot insert rows just because the booking is already
  // WAITING_CUSTOMER_APPROVAL from a competing request.
  const statements = [
    d1.prepare(`
      INSERT INTO "ServiceTimelineEvent"
        ("id", "bookingId", "eventType", "timestamp", "actor", "metadata", "idempotencyKey")
      SELECT ?, ?, 'extra_proposal', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM "ServiceBooking" b
        WHERE b."id" = ? AND b."status" = ?
      )
      ${findingGuard}
    `).bind(...timelineBindings),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = 'WAITING_CUSTOMER_APPROVAL', "updatedAt" = ?
      WHERE "id" = ? AND "status" = ?
        AND EXISTS (
          SELECT 1 FROM "ServiceTimelineEvent" e
          WHERE e."id" = ? AND e."bookingId" = ?
        )
    `).bind(now, input.bookingId, input.expectedBookingStatus, timelineId, input.bookingId),
  ];

  if (input.newFinding && findingId) {
    statements.push(d1.prepare(`
      INSERT INTO "Finding"
        ("id", "bookingId", "category", "title", "description", "severity")
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM "ServiceBooking" b
        WHERE b."id" = ? AND b."status" = 'WAITING_CUSTOMER_APPROVAL'
      )
        AND EXISTS (
          SELECT 1 FROM "ServiceTimelineEvent" e
          WHERE e."id" = ? AND e."bookingId" = ?
        )
    `).bind(
      findingId,
      input.bookingId,
      input.newFinding.category,
      input.newFinding.title,
      input.newFinding.description,
      input.newFinding.severity,
      input.bookingId,
      timelineId,
      input.bookingId,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "CustomerApproval"
      ("id", "bookingId", "findingId", "proposedItem", "description",
       "partName", "partBrand", "partNumber", "partType", "quantity",
       "partPrice", "laborPrice", "totalPrice", "imageUrl", "technicianNote", "status")
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED'
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = 'WAITING_CUSTOMER_APPROVAL'
    )
      AND EXISTS (
        SELECT 1 FROM "ServiceTimelineEvent" e
        WHERE e."id" = ? AND e."bookingId" = ?
      )
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM "Finding" f
        WHERE f."id" = ? AND f."bookingId" = ?
      ))
  `).bind(
    approvalId,
    input.bookingId,
    findingId,
    input.proposal.proposedItem,
    input.details.description,
    input.details.partName,
    input.details.partBrand,
    input.details.partNumber,
    input.details.partType,
    input.proposal.quantity,
    input.proposal.partPrice,
    input.proposal.laborPrice,
    totalPrice,
    input.details.imageUrl,
    input.details.technicianNote,
    input.bookingId,
    timelineId,
    input.bookingId,
    findingId,
    findingId,
    input.bookingId,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraProposalConflictError();
  }

  const approval = await db.customerApproval.findUnique({ where: { id: approvalId } });
  if (!approval) throw new Error("CARE proposal transaction committed without its approval row");
  return approval;
}

export async function createCareExtraProposalAtomically(
  db: PrismaClient,
  input: CreateCareExtraProposalInput,
) {
  const d1 = await getD1Binding();
  if (d1) return createWithD1(db, d1, input);
  return createWithPrisma(db, input);
}
