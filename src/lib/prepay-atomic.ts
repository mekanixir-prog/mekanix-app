import type { PrismaClient } from "@prisma/client";

type PrepayInput = {
  jobId: string;
  jobCode: string;
  technicianId: string;
  gross: number;
  commission: number;
  net: number;
  inspectionFee: number;
  travelFee: number;
  paidAt: Date;
  machineLabel: "heavy" | "passenger";
};

type D1Result = { meta?: { changes?: number } };
type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

/**
 * Records the prepay, commission, wallet hold and ledger entries as one unit.
 * Deterministic idempotency keys make retries safe. Unexpected key collisions
 * abort the whole batch/transaction; they are never silently ignored. Notifications
 * deliberately remain outside this financial transaction and are best effort.
 */
export async function recordPrepayWithPrisma(
  db: PrismaClient,
  input: PrepayInput
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const jobUpdate = await tx.job.updateMany({
      where: { id: input.jobId, prepayPaid: false },
      data: {
        prepayPaid: true,
        prepayPaidAt: input.paidAt,
        inspectionFee: input.inspectionFee,
        travelFee: input.travelFee,
        platformCommission: input.commission,
        netEarnings: input.net,
        holdUntil: null,
      },
    });
    if (jobUpdate.count !== 1) return false;

    const wallet = await tx.wallet.upsert({
      where: { technicianId: input.technicianId },
      create: { technicianId: input.technicianId },
      update: {},
      select: { id: true, pendingBalance: true },
    });

    const prepayKey = `prepay:${input.jobId}:PREPAY`;
    const commissionKey = `prepay:${input.jobId}:COMMISSION`;
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        jobId: input.jobId,
        kind: "PREPAY",
        status: "PENDING",
        grossAmount: input.gross,
        commissionAmount: input.commission,
        netAmount: input.net,
        holdUntil: null,
        description: `Pre-service payment — ${input.jobCode} (${input.machineLabel})`,
        idempotencyKey: prepayKey,
      },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        jobId: input.jobId,
        kind: "COMMISSION",
        status: "COMPLETED",
        grossAmount: 0,
        commissionAmount: input.commission,
        netAmount: -input.commission,
        description: `Platform commission (10%) — ${input.jobCode}`,
        idempotencyKey: commissionKey,
      },
    });

    await tx.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: "HOLD",
        amount: input.net,
        balanceBefore: wallet.pendingBalance,
        balanceAfter: Number(wallet.pendingBalance) + input.net,
        referenceType: "Job",
        referenceId: input.jobId,
        description: `Prepay escrow — ${input.jobCode}`,
        idempotencyKey: `prepay:${input.jobId}:LEDGER_HOLD`,
      },
    });
    await tx.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: "COMMISSION",
        amount: -input.commission,
        balanceBefore: wallet.pendingBalance,
        balanceAfter: wallet.pendingBalance,
        referenceType: "Job",
        referenceId: input.jobId,
        description: `Platform commission — ${input.jobCode}`,
        idempotencyKey: `prepay:${input.jobId}:LEDGER_COMMISSION`,
      },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        pendingBalance: { increment: input.net },
        totalEarned: { increment: input.gross },
        totalCommission: { increment: input.commission },
      },
    });
    return true;
  });
}

/**
 * D1 implementation. D1 batch is transactional; each dependent write is
 * guarded by the Job's exact paidAt marker. The wallet aggregate update is
 * guarded by changes() from insertion of the unique HOLD ledger row. Unique-key
 * conflicts on any financial row are allowed to abort the batch so no partial
 * settlement can commit; post-batch result checks are assertions, not rollback.
 */
export async function recordPrepayWithD1(
  d1: D1Database,
  input: PrepayInput
): Promise<boolean> {
  const at = input.paidAt.toISOString();
  const walletId = crypto.randomUUID();
  const prepayKey = `prepay:${input.jobId}:PREPAY`;
  const commissionKey = `prepay:${input.jobId}:COMMISSION`;
  const holdLedgerKey = `prepay:${input.jobId}:LEDGER_HOLD`;
  const commissionLedgerKey = `prepay:${input.jobId}:LEDGER_COMMISSION`;
  const marker = `"id" = ? AND "prepayPaid" = 1 AND "prepayPaidAt" = ?`;
  const joinedJobMarker = `j."id" = ? AND j."prepayPaid" = 1 AND j."prepayPaidAt" = ?`;

  const statements = [
    d1.prepare(`
      UPDATE "Job"
      SET "prepayPaid" = 1, "prepayPaidAt" = ?, "inspectionFee" = ?,
          "travelFee" = ?, "platformCommission" = ?, "netEarnings" = ?,
          "holdUntil" = NULL, "updatedAt" = ?
      WHERE "id" = ? AND "prepayPaid" = 0
    `).bind(at, input.inspectionFee, input.travelFee, input.commission, input.net, at, input.jobId),

    d1.prepare(`
      INSERT INTO "Wallet" ("id", "technicianId", "createdAt", "updatedAt")
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM "Job" WHERE ${marker})
      ON CONFLICT("technicianId") DO NOTHING
    `).bind(walletId, input.technicianId, at, at, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "holdUntil", "description",
         "idempotencyKey", "createdAt")
      SELECT ?, w."id", j."id", 'PREPAY', 'PENDING', ?, ?, ?, NULL, ?, ?, ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.gross, input.commission, input.net,
      `Pre-service payment — ${input.jobCode} (${input.machineLabel})`,
      prepayKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "description", "idempotencyKey", "createdAt")
      SELECT ?, w."id", j."id", 'COMMISSION', 'COMPLETED', 0, ?, ?, ?, ?, ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.commission, -input.commission,
      `Platform commission (10%) — ${input.jobCode}`,
      commissionKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "createdAt")
      SELECT ?, w."id", 'HOLD', ?, w."pendingBalance", w."pendingBalance" + ?,
             'Job', j."id", ?, ?, ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.net, input.net,
      `Prepay escrow — ${input.jobCode}`, holdLedgerKey, at,
      input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      UPDATE "Wallet"
      SET "pendingBalance" = "pendingBalance" + ?,
          "totalEarned" = "totalEarned" + ?,
          "totalCommission" = "totalCommission" + ?,
          "updatedAt" = ?
      WHERE "technicianId" = ? AND changes() = 1
    `).bind(input.net, input.gross, input.commission, at, input.technicianId),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "createdAt")
      SELECT ?, w."id", 'COMMISSION', ?, w."pendingBalance", w."pendingBalance",
             'Job', j."id", ?, ?, ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), -input.commission,
      `Platform commission — ${input.jobCode}`, commissionLedgerKey, at,
      input.technicianId, input.technicianId, input.jobId, at),
  ];

  const results = await d1.batch(statements);
  const changes = results.map((result) => result.meta?.changes ?? 0);
  if (changes[0] === 0) return false;
  if (changes[1] > 1 || changes[2] !== 1 || changes[3] !== 1 ||
      changes[4] !== 1 || changes[5] !== 1 || changes[6] !== 1) {
    throw new Error("D1 prepay batch did not create the complete financial record set");
  }
  return true;
}

export async function recordPrepayAtomically(
  db: PrismaClient,
  input: PrepayInput
): Promise<boolean> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return recordPrepayWithPrisma(db, input);

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  const d1 = (context.env as unknown as { DB?: D1Database }).DB;
  if (!d1) throw new Error("D1 binding 'DB' is unavailable for atomic prepay");
  return recordPrepayWithD1(d1, input);
}
