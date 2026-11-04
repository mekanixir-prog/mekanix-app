import type { PrismaClient } from "@prisma/client";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

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
function isValidPrepayInput(input: PrepayInput): boolean {
  const values = [input.gross, input.commission, input.net, input.inspectionFee, input.travelFee];
  return values.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    input.gross > 0 && input.gross === input.inspectionFee + input.travelFee &&
    input.gross === input.commission + input.net;
}

export async function recordPrepayWithPrisma(
  db: PrismaClient,
  input: PrepayInput
): Promise<boolean> {
  if (!isValidPrepayInput(input)) return false;
  return db.$transaction(async (tx) => {
    const wallet = await tx.wallet.upsert({
      where: { technicianId: input.technicianId },
      create: { technicianId: input.technicianId, financialUnitStatus: "VERIFIED_IRR" },
      update: {},
      select: { id: true, balance: true, pendingBalance: true, totalEarned: true, totalCommission: true, financialUnitStatus: true },
    });
    if (wallet.financialUnitStatus !== "VERIFIED_IRR" ||
        ![wallet.balance, wallet.pendingBalance, wallet.totalEarned, wallet.totalCommission].every(isSafeStoredIrrAmount)) return false;
    const nextAggregates = [
      Number(wallet.pendingBalance) + input.net,
      Number(wallet.totalEarned) + input.gross,
      Number(wallet.totalCommission) + input.commission,
    ];
    if (!nextAggregates.every(Number.isSafeInteger)) return false;

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
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
    if (jobUpdate.count !== 1) return false;

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
        financialUnitStatus: "VERIFIED_IRR",
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
        description: `Platform commission — ${input.jobCode}`,
        idempotencyKey: commissionKey,
        financialUnitStatus: "VERIFIED_IRR",
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
        financialUnitStatus: "VERIFIED_IRR",
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
        financialUnitStatus: "VERIFIED_IRR",
      },
    });

    const walletUpdate = await tx.wallet.updateMany({
      where: { id: wallet.id, financialUnitStatus: "VERIFIED_IRR" },
      data: {
        pendingBalance: { increment: input.net },
        totalEarned: { increment: input.gross },
        totalCommission: { increment: input.commission },
      },
    });
    if (walletUpdate.count !== 1) throw new Error("Verified IRR wallet aggregate update failed");
    return true;
  });
}

/**
 * D1 implementation. D1 batch is transactional; each dependent write is
 * guarded by the Job's exact paidAt marker. The wallet aggregate update is
 * guarded by row-level IRR provenance, safe-integer aggregates, and SQL
 * assertions after each required write. A failed assertion aborts the D1 batch
 * so the paid marker, wallet aggregates, and ledger rows cannot partially commit.
 */
export async function recordPrepayWithD1(
  d1: D1Database,
  input: PrepayInput
): Promise<boolean> {
  if (!isValidPrepayInput(input)) return false;
  const at = input.paidAt.toISOString();
  const walletId = crypto.randomUUID();
  const prepayKey = "prepay:" + input.jobId + ":PREPAY";
  const commissionKey = "prepay:" + input.jobId + ":COMMISSION";
  const holdLedgerKey = "prepay:" + input.jobId + ":LEDGER_HOLD";
  const commissionLedgerKey = "prepay:" + input.jobId + ":LEDGER_COMMISSION";
  const assertOneChange = () =>
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();
  const assertVerifiedWallet = () => d1.prepare(
    "SELECT CASE WHEN EXISTS (" +
    "SELECT 1 FROM \"Wallet\" WHERE \"technicianId\" = ? AND \"financialUnitStatus\" = 'VERIFIED_IRR' " +
    "AND \"balance\" = CAST(\"balance\" AS INTEGER) AND abs(\"balance\") <= 9007199254740991 " +
    "AND \"pendingBalance\" = CAST(\"pendingBalance\" AS INTEGER) AND abs(\"pendingBalance\") <= 9007199254740991 " +
    "AND \"totalEarned\" = CAST(\"totalEarned\" AS INTEGER) AND abs(\"totalEarned\") <= 9007199254740991 " +
    "AND \"totalCommission\" = CAST(\"totalCommission\" AS INTEGER) AND abs(\"totalCommission\") <= 9007199254740991" +
    ") THEN 1 ELSE json_extract('not-json', '$') END"
  ).bind(input.technicianId);

  const statements = [
    d1.prepare(
      "UPDATE \"Job\" SET \"prepayPaid\" = 1, \"prepayPaidAt\" = ?, \"inspectionFee\" = ?, " +
      "\"travelFee\" = ?, \"platformCommission\" = ?, \"netEarnings\" = ?, \"holdUntil\" = NULL, " +
      "\"financialUnitStatus\" = 'VERIFIED_IRR', \"updatedAt\" = ? WHERE \"id\" = ? AND \"prepayPaid\" = 0"
    ).bind(at, input.inspectionFee, input.travelFee, input.commission, input.net, at, input.jobId),
    assertOneChange(),

    d1.prepare(
      "INSERT INTO \"Wallet\" (\"id\", \"technicianId\", \"financialUnitStatus\", \"createdAt\", \"updatedAt\") " +
      "SELECT ?, ?, 'VERIFIED_IRR', ?, ? WHERE EXISTS (" +
      "SELECT 1 FROM \"Job\" WHERE \"id\" = ? AND \"prepayPaid\" = 1 AND \"prepayPaidAt\" = ?" +
      ") ON CONFLICT(\"technicianId\") DO NOTHING"
    ).bind(walletId, input.technicianId, at, at, input.jobId, at),
    assertVerifiedWallet(),

    d1.prepare(
      "INSERT INTO \"WalletTransaction\" (\"id\", \"walletId\", \"jobId\", \"kind\", \"status\", " +
      "\"grossAmount\", \"commissionAmount\", \"netAmount\", \"holdUntil\", \"description\", " +
      "\"idempotencyKey\", \"financialUnitStatus\", \"createdAt\") " +
      "SELECT ?, w.\"id\", j.\"id\", 'PREPAY', 'PENDING', ?, ?, ?, NULL, ?, ?, 'VERIFIED_IRR', ? " +
      "FROM \"Wallet\" w JOIN \"Job\" j ON j.\"technicianId\" = ? " +
      "WHERE w.\"technicianId\" = ? AND w.\"financialUnitStatus\" = 'VERIFIED_IRR' " +
      "AND j.\"id\" = ? AND j.\"prepayPaid\" = 1 AND j.\"prepayPaidAt\" = ?"
    ).bind(crypto.randomUUID(), input.gross, input.commission, input.net,
      "Pre-service payment — " + input.jobCode + " (" + input.machineLabel + ")",
      prepayKey, at, input.technicianId, input.technicianId, input.jobId, at),
    assertOneChange(),

    d1.prepare(
      "INSERT INTO \"WalletTransaction\" (\"id\", \"walletId\", \"jobId\", \"kind\", \"status\", " +
      "\"grossAmount\", \"commissionAmount\", \"netAmount\", \"description\", \"idempotencyKey\", " +
      "\"financialUnitStatus\", \"createdAt\") " +
      "SELECT ?, w.\"id\", j.\"id\", 'COMMISSION', 'COMPLETED', 0, ?, ?, ?, ?, 'VERIFIED_IRR', ? " +
      "FROM \"Wallet\" w JOIN \"Job\" j ON j.\"technicianId\" = ? " +
      "WHERE w.\"technicianId\" = ? AND w.\"financialUnitStatus\" = 'VERIFIED_IRR' " +
      "AND j.\"id\" = ? AND j.\"prepayPaid\" = 1 AND j.\"prepayPaidAt\" = ?"
    ).bind(crypto.randomUUID(), input.commission, -input.commission,
      "Platform commission — " + input.jobCode,
      commissionKey, at, input.technicianId, input.technicianId, input.jobId, at),
    assertOneChange(),

    d1.prepare(
      "INSERT INTO \"WalletLedger\" (\"id\", \"walletId\", \"type\", \"amount\", \"balanceBefore\", " +
      "\"balanceAfter\", \"referenceType\", \"referenceId\", \"description\", \"idempotencyKey\", " +
      "\"financialUnitStatus\", \"createdAt\") " +
      "SELECT ?, w.\"id\", 'HOLD', ?, w.\"pendingBalance\", w.\"pendingBalance\" + ?, " +
      "'Job', j.\"id\", ?, ?, 'VERIFIED_IRR', ? FROM \"Wallet\" w " +
      "JOIN \"Job\" j ON j.\"technicianId\" = ? " +
      "WHERE w.\"technicianId\" = ? AND w.\"financialUnitStatus\" = 'VERIFIED_IRR' " +
      "AND j.\"id\" = ? AND j.\"prepayPaid\" = 1 AND j.\"prepayPaidAt\" = ?"
    ).bind(crypto.randomUUID(), input.net, input.net,
      "Prepay escrow — " + input.jobCode, holdLedgerKey, at,
      input.technicianId, input.technicianId, input.jobId, at),
    assertOneChange(),

    d1.prepare(
      "UPDATE \"Wallet\" SET \"pendingBalance\" = \"pendingBalance\" + ?, " +
      "\"totalEarned\" = \"totalEarned\" + ?, \"totalCommission\" = \"totalCommission\" + ?, " +
      "\"updatedAt\" = ? WHERE \"technicianId\" = ? AND \"financialUnitStatus\" = 'VERIFIED_IRR' " +
      "AND \"pendingBalance\" = CAST(\"pendingBalance\" AS INTEGER) AND abs(\"pendingBalance\") <= 9007199254740991 " +
      "AND \"totalEarned\" = CAST(\"totalEarned\" AS INTEGER) AND abs(\"totalEarned\") <= 9007199254740991 " +
      "AND \"totalCommission\" = CAST(\"totalCommission\" AS INTEGER) AND abs(\"totalCommission\") <= 9007199254740991 " +
      "AND EXISTS (SELECT 1 FROM \"WalletLedger\" WHERE \"idempotencyKey\" = ? AND \"walletId\" = \"Wallet\".\"id\")"
    ).bind(input.net, input.gross, input.commission, at, input.technicianId, holdLedgerKey),
    assertOneChange(),
    assertVerifiedWallet(),

    d1.prepare(
      "INSERT INTO \"WalletLedger\" (\"id\", \"walletId\", \"type\", \"amount\", \"balanceBefore\", " +
      "\"balanceAfter\", \"referenceType\", \"referenceId\", \"description\", \"idempotencyKey\", " +
      "\"financialUnitStatus\", \"createdAt\") " +
      "SELECT ?, w.\"id\", 'COMMISSION', ?, w.\"pendingBalance\", w.\"pendingBalance\", " +
      "'Job', j.\"id\", ?, ?, 'VERIFIED_IRR', ? FROM \"Wallet\" w " +
      "JOIN \"Job\" j ON j.\"technicianId\" = ? " +
      "WHERE w.\"technicianId\" = ? AND w.\"financialUnitStatus\" = 'VERIFIED_IRR' " +
      "AND j.\"id\" = ? AND j.\"prepayPaid\" = 1 AND j.\"prepayPaidAt\" = ?"
    ).bind(crypto.randomUUID(), -input.commission,
      "Platform commission — " + input.jobCode, commissionLedgerKey, at,
      input.technicianId, input.technicianId, input.jobId, at),
    assertOneChange(),
  ];

  try {
    await d1.batch(statements);
    return true;
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return false;
    throw error;
  }
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
) END").bind();
  const assertVerifiedWallet = () => d1.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM "Wallet" WHERE "technicianId" = ? AND "financialUnitStatus" = 'VERIFIED_IRR'
      AND "balance" = CAST("balance" AS INTEGER) AND abs("balance") <= 9007199254740991
      AND "pendingBalance" = CAST("pendingBalance" AS INTEGER) AND abs("pendingBalance") <= 9007199254740991
      AND "totalEarned" = CAST("totalEarned" AS INTEGER) AND abs("totalEarned") <= 9007199254740991
      AND "totalCommission" = CAST("totalCommission" AS INTEGER) AND abs("totalCommission") <= 9007199254740991
  ) THEN 1 ELSE json_extract('not-json', '
    d1.prepare(`
      UPDATE "Job"
      SET "prepayPaid" = 1, "prepayPaidAt" = ?, "inspectionFee" = ?,
          "travelFee" = ?, "platformCommission" = ?, "netEarnings" = ?,
          "holdUntil" = NULL, "financialUnitStatus" = 'VERIFIED_IRR', "updatedAt" = ?
      WHERE "id" = ? AND "prepayPaid" = 0
    `).bind(at, input.inspectionFee, input.travelFee, input.commission, input.net, at, input.jobId),

    d1.prepare(`
      INSERT INTO "Wallet" ("id", "technicianId", "financialUnitStatus", "createdAt", "updatedAt")
      SELECT ?, ?, 'VERIFIED_IRR', ?, ?
      WHERE EXISTS (SELECT 1 FROM "Job" WHERE ${marker})
      ON CONFLICT("technicianId") DO NOTHING
    `).bind(walletId, input.technicianId, at, at, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "holdUntil", "description",
         "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", j."id", 'PREPAY', 'PENDING', ?, ?, ?, NULL, ?, ?, 'VERIFIED_IRR', ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.gross, input.commission, input.net,
      `Pre-service payment — ${input.jobCode} (${input.machineLabel})`,
      prepayKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", j."id", 'COMMISSION', 'COMPLETED', 0, ?, ?, ?, ?, 'VERIFIED_IRR', ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.commission, -input.commission,
      `Platform commission (10%) — ${input.jobCode}`,
      commissionKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", 'HOLD', ?, w."pendingBalance", w."pendingBalance" + ?,
             'Job', j."id", ?, ?, 'VERIFIED_IRR', ?
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
      WHERE "technicianId" = ? AND "financialUnitStatus" = 'VERIFIED_IRR' AND changes() = 1
    `).bind(input.net, input.gross, input.commission, at, input.technicianId),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", 'COMMISSION', ?, w."pendingBalance", w."pendingBalance",
             'Job', j."id", ?, ?, 'VERIFIED_IRR', ?
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
) END`).bind(input.technicianId);

  const statements = [
    d1.prepare(`
      UPDATE "Job"
      SET "prepayPaid" = 1, "prepayPaidAt" = ?, "inspectionFee" = ?,
          "travelFee" = ?, "platformCommission" = ?, "netEarnings" = ?,
          "holdUntil" = NULL, "financialUnitStatus" = 'VERIFIED_IRR', "updatedAt" = ?
      WHERE "id" = ? AND "prepayPaid" = 0
    `).bind(at, input.inspectionFee, input.travelFee, input.commission, input.net, at, input.jobId),

    d1.prepare(`
      INSERT INTO "Wallet" ("id", "technicianId", "financialUnitStatus", "createdAt", "updatedAt")
      SELECT ?, ?, 'VERIFIED_IRR', ?, ?
      WHERE EXISTS (SELECT 1 FROM "Job" WHERE ${marker})
      ON CONFLICT("technicianId") DO NOTHING
    `).bind(walletId, input.technicianId, at, at, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "holdUntil", "description",
         "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", j."id", 'PREPAY', 'PENDING', ?, ?, ?, NULL, ?, ?, 'VERIFIED_IRR', ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.gross, input.commission, input.net,
      `Pre-service payment — ${input.jobCode} (${input.machineLabel})`,
      prepayKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "jobId", "kind", "status", "grossAmount",
         "commissionAmount", "netAmount", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", j."id", 'COMMISSION', 'COMPLETED', 0, ?, ?, ?, ?, 'VERIFIED_IRR', ?
      FROM "Wallet" w JOIN "Job" j ON j."technicianId" = ?
      WHERE w."technicianId" = ? AND ${joinedJobMarker}
    `).bind(crypto.randomUUID(), input.commission, -input.commission,
      `Platform commission (10%) — ${input.jobCode}`,
      commissionKey, at, input.technicianId, input.technicianId, input.jobId, at),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", 'HOLD', ?, w."pendingBalance", w."pendingBalance" + ?,
             'Job', j."id", ?, ?, 'VERIFIED_IRR', ?
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
      WHERE "technicianId" = ? AND "financialUnitStatus" = 'VERIFIED_IRR' AND changes() = 1
    `).bind(input.net, input.gross, input.commission, at, input.technicianId),

    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
      SELECT ?, w."id", 'COMMISSION', ?, w."pendingBalance", w."pendingBalance",
             'Job', j."id", ?, ?, 'VERIFIED_IRR', ?
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
