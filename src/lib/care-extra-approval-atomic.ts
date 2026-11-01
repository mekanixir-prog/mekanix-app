import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

export class CareExtraApprovalConflictError extends Error {
  constructor() {
    super("The proposal or booking is no longer awaiting this decision");
    this.name = "CareExtraApprovalConflictError";
  }
}

export type CareExtraApprovalDecisionInput = {
  bookingId: string;
  approvalId: string;
  findingId: string | null;
  actorUserId: string;
  decision: "CUSTOMER_APPROVED" | "CUSTOMER_REJECTED";
};

function getDecisionValues(decision: CareExtraApprovalDecisionInput["decision"]) {
  return decision === "CUSTOMER_APPROVED"
    ? {
        bookingStatus: "APPROVED",
        findingStatus: "APPROVED",
        eventType: "customer_approved",
        approvedAt: new Date(),
        rejectedAt: null,
      }
    : {
        bookingStatus: "INSPECTING",
        findingStatus: "REJECTED",
        eventType: "customer_rejected",
        approvedAt: null,
        rejectedAt: new Date(),
      };
}

async function decideWithPrisma(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  return db.$transaction(async (tx) => {
    const values = getDecisionValues(input.decision);
    const approvalClaim = await tx.customerApproval.updateMany({
      where: {
        id: input.approvalId,
        bookingId: input.bookingId,
        status: "PROPOSED",
        findingId: input.findingId,
        ...(input.findingId ? { finding: { is: { id: input.findingId, bookingId: input.bookingId } } } : {}),
      },
      data: {
        status: input.decision,
        approvedAt: values.approvedAt,
        rejectedAt: values.rejectedAt,
      },
    });
    if (approvalClaim.count !== 1) {
      throw new CareExtraApprovalConflictError();
    }

    const bookingClaim = await tx.serviceBooking.updateMany({
      where: { id: input.bookingId, status: "WAITING_CUSTOMER_APPROVAL" },
      data: { status: values.bookingStatus, updatedAt: new Date() },
    });
    if (bookingClaim.count !== 1) {
      throw new CareExtraApprovalConflictError();
    }

    if (input.findingId) {
      const findingClaim = await tx.finding.updateMany({
        where: { id: input.findingId, bookingId: input.bookingId },
        data: { status: values.findingStatus },
      });
      if (findingClaim.count !== 1) {
        throw new CareExtraApprovalConflictError();
      }
    }

    await tx.serviceTimelineEvent.create({
      data: {
        bookingId: input.bookingId,
        eventType: values.eventType,
        actor: input.actorUserId,
        metadata: JSON.stringify({ approvalId: input.approvalId }),
      },
    });

    const approval = await tx.customerApproval.findUnique({
      where: { id: input.approvalId },
    });
    if (!approval) throw new Error("Approved proposal could not be loaded after transaction");
    return approval;
  });
}

async function decideWithD1(
  db: PrismaClient,
  d1: NonNullable<Awaited<ReturnType<typeof getD1Binding>>>,
  input: CareExtraApprovalDecisionInput,
) {
  const values = getDecisionValues(input.decision);
  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const approvalStatus = input.decision;
  const findingStatus = values.findingStatus;
  const bookingStatus = values.bookingStatus;
  const findingGuard = input.findingId
    ? 'AND EXISTS (SELECT 1 FROM "Finding" f WHERE f."id" = ? AND f."bookingId" = ?)'
    : "";
  const approvalBindings: unknown[] = [
    approvalStatus,
    values.approvedAt?.toISOString() ?? null,
    values.rejectedAt?.toISOString() ?? null,
    input.approvalId,
    input.bookingId,
    input.findingId,
    input.bookingId,
  ];
  if (input.findingId) approvalBindings.push(input.findingId, input.bookingId);

  const statements = [
    d1.prepare(`
      UPDATE "CustomerApproval"
      SET "status" = ?, "approvedAt" = ?, "rejectedAt" = ?
      WHERE "id" = ? AND "bookingId" = ? AND "status" = 'PROPOSED'
        AND "findingId" IS ?
        AND EXISTS (
          SELECT 1 FROM "ServiceBooking" b
          WHERE b."id" = ? AND b."status" = 'WAITING_CUSTOMER_APPROVAL'
        )
        ${findingGuard}
    `).bind(...approvalBindings),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
    d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
    statements.push(d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));
  statements.push(d1.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`));

  let results;
  try {
    results = await d1.batch(statements);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      throw new CareExtraApprovalConflictError();
    }
    throw error;
  }
  const mutationResults = results.filter((_, index) => index % 2 === 0);
  if (mutationResults.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
) END`),
    d1.prepare(`
      UPDATE "ServiceBooking"
      SET "status" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'WAITING_CUSTOMER_APPROVAL'
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ?
            AND a."status" = ?
        )
    `).bind(bookingStatus, now, input.bookingId, input.approvalId, input.bookingId, approvalStatus),
  ];

  if (input.findingId) {
    statements.push(d1.prepare(`
      UPDATE "Finding"
      SET "status" = ?
      WHERE "id" = ? AND "bookingId" = ?
        AND EXISTS (
          SELECT 1 FROM "CustomerApproval" a
          WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
        )
    `).bind(
      findingStatus,
      input.findingId,
      input.bookingId,
      input.approvalId,
      input.bookingId,
      approvalStatus,
    ));
  }

  statements.push(d1.prepare(`
    INSERT INTO "ServiceTimelineEvent"
      ("id", "bookingId", "eventType", "timestamp", "actor", "metadata")
    SELECT ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM "ServiceBooking" b
      WHERE b."id" = ? AND b."status" = ?
    )
      AND EXISTS (
        SELECT 1 FROM "CustomerApproval" a
        WHERE a."id" = ? AND a."bookingId" = ? AND a."status" = ?
      )
  `).bind(
    eventId,
    input.bookingId,
    values.eventType,
    now,
    input.actorUserId,
    JSON.stringify({ approvalId: input.approvalId }),
    input.bookingId,
    bookingStatus,
    input.approvalId,
    input.bookingId,
    approvalStatus,
  ));

  const results = await d1.batch(statements);
  if (results.some((result) => (result?.meta?.changes ?? 0) !== 1)) {
    throw new CareExtraApprovalConflictError();
  }

  const approval = await db.customerApproval.findUnique({
    where: { id: input.approvalId },
  });
  if (!approval) throw new Error("Approved proposal could not be loaded after D1 batch");
  return approval;
}

export async function decideCareExtraApprovalAtomically(
  db: PrismaClient,
  input: CareExtraApprovalDecisionInput,
) {
  const d1 = await getD1Binding();
  if (d1) return decideWithD1(db, d1, input);
  return decideWithPrisma(db, input);
}
