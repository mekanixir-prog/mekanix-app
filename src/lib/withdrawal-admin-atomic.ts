import type { PrismaClient } from "@prisma/client";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

type Action = "APPROVED" | "REJECTED" | "PAID";
type Input = {
  withdrawalId: string;
  action: Action;
  adminId: string;
  adminNotes: string | null;
  at: Date;
  payoutReference?: string | null;
};
type D1Result = { meta?: { changes?: number } };
type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

/** All Node financial transitions commit the request, wallet and ledger together. */
export async function updateWithdrawalWithPrisma(
  db: PrismaClient,
  input: Input,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawalRequest.findUnique({
      where: { id: input.withdrawalId },
      select: { id: true, walletId: true, amount: true, status: true, financialUnitStatus: true, idempotencyKey: true },
    });
    if (!withdrawal) throw new Error("درخواست برداشت پیدا نشد");
    if (withdrawal.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(withdrawal.amount) || Number(withdrawal.amount) <= 0) return false;
    const amount = Number(withdrawal.amount);
    const debitLedger = withdrawal.idempotencyKey
      ? await tx.walletLedger.findUnique({ where: { idempotencyKey: "withdrawal:" + withdrawal.idempotencyKey + ":LEDGER" } })
      : null;
    const debitBefore = debitLedger?.balanceBefore;
    const debitAfter = debitLedger?.balanceAfter;
    const debitLedgerVerified = Boolean(
      debitLedger &&
      debitLedger.walletId === withdrawal.walletId &&
      debitLedger.financialUnitStatus === "VERIFIED_IRR" &&
      debitLedger.type === "WITHDRAWAL" &&
      debitLedger.amount !== null && debitLedger.amount !== undefined &&
      isSafeStoredIrrAmount(debitLedger.amount) && Number(debitLedger.amount) === -amount &&
      debitLedger.referenceType === "Withdrawal" && debitLedger.referenceId === withdrawal.id &&
      isSafeStoredIrrAmount(debitBefore) && isSafeStoredIrrAmount(debitAfter) &&
      Number(debitBefore) >= amount && Number(debitAfter) >= 0 &&
      Number(debitAfter) === Number(debitBefore) - amount
    );
    if (!debitLedgerVerified) return false;

    const walletProvenance = await tx.wallet.findUnique({ where: { id: withdrawal.walletId }, select: { financialUnitStatus: true, balance: true, totalWithdrawn: true } });
    if (walletProvenance?.financialUnitStatus !== "VERIFIED_IRR" ||
        !isSafeStoredIrrAmount(walletProvenance.balance) || Number(walletProvenance.balance) < 0 ||
        !isSafeStoredIrrAmount(walletProvenance.totalWithdrawn) || Number(walletProvenance.totalWithdrawn) < 0) return false;
    if (input.action === "REJECTED" && !Number.isSafeInteger(Number(walletProvenance.balance) + amount)) return false;
    if (input.action === "PAID" && !Number.isSafeInteger(Number(walletProvenance.totalWithdrawn) + amount)) return false;

    if (input.action === "APPROVED") {
      if (withdrawal.status !== "REQUESTED") return false;
      const result = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawal.id, status: "REQUESTED", financialUnitStatus: "VERIFIED_IRR" },
        data: { status: "APPROVED", reviewerId: input.adminId, adminNotes: input.adminNotes },
      });
      return result.count === 1;
    }

    if (input.action === "REJECTED") {
      if (withdrawal.status !== "REQUESTED" && withdrawal.status !== "APPROVED") return false;
      const transition = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawal.id, status: { in: ["REQUESTED", "APPROVED"] }, financialUnitStatus: "VERIFIED_IRR" },
        data: {
          status: "REJECTED",
          reviewerId: input.adminId,
          adminNotes: input.adminNotes,
          processedAt: input.at,
        },
      });
      if (transition.count !== 1) return false;

      const walletUpdate = await tx.wallet.updateMany({
        where: { id: withdrawal.walletId, financialUnitStatus: "VERIFIED_IRR", balance: walletProvenance.balance },
        data: { balance: { increment: withdrawal.amount } },
      });
      if (walletUpdate.count !== 1) {
        throw new Error("کیف پول برای بازگشت مبلغ پیدا نشد؛ عملیات لغو شد");
      }
      const wallet = await tx.wallet.findUnique({
        where: { id: withdrawal.walletId },
        select: { balance: true, financialUnitStatus: true },
      });
      if (!wallet || wallet.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(wallet.balance) || Number(wallet.balance) < 0) throw new Error("کیف پول پس از بازگشت وجه از نظر مالی معتبر نیست");

      await tx.walletLedger.create({
        data: {
          walletId: withdrawal.walletId,
          type: "REFUND",
          amount: withdrawal.amount,
          balanceBefore: Number(wallet.balance) - Number(withdrawal.amount),
          balanceAfter: Number(wallet.balance),
          referenceType: "Withdrawal",
          referenceId: withdrawal.id,
          description: `Refund for rejected withdrawal ${withdrawal.id}`,
          idempotencyKey: `withdrawal:${withdrawal.id}:REJECT_REFUND`,
          financialUnitStatus: "VERIFIED_IRR",
          createdBy: input.adminId,
        },
      });
      return true;
    }

    if (withdrawal.status !== "APPROVED") return false;
    const payoutReference = input.payoutReference?.trim();
    if (!payoutReference || payoutReference.length < 3 || payoutReference.length > 128) {
      throw new Error("شناسه پیگیری واقعی انتقال بانکی الزامی است");
    }
    const payoutId = crypto.randomUUID();
    const transition = await tx.withdrawalRequest.updateMany({
      where: { id: withdrawal.id, status: "APPROVED", financialUnitStatus: "VERIFIED_IRR" },
      data: {
        status: "PAID",
        reviewerId: input.adminId,
        adminNotes: input.adminNotes,
        processedAt: input.at,
        txnId: payoutReference,
      },
    });
    if (transition.count !== 1) return false;

    await tx.walletTransaction.create({
      data: {
        id: payoutId,
        walletId: withdrawal.walletId,
        kind: "PAYOUT",
        status: "COMPLETED",
        grossAmount: withdrawal.amount,
        commissionAmount: 0,
        netAmount: -Number(withdrawal.amount),
        description: `Payout for withdrawal ${withdrawal.id}; bank reference ${payoutReference}`,
        idempotencyKey: `withdrawal:${withdrawal.id}:PAYOUT`,
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
    const walletUpdate = await tx.wallet.updateMany({
      where: { id: withdrawal.walletId, financialUnitStatus: "VERIFIED_IRR", totalWithdrawn: walletProvenance.totalWithdrawn },
      data: { totalWithdrawn: { increment: withdrawal.amount } },
    });
    if (walletUpdate.count !== 1) {
      throw new Error("کیف پول برای ثبت پرداخت پیدا نشد؛ عملیات لغو شد");
    }
    return true;
  });
}

/**
 * Cloudflare D1: each required compare-and-set is followed by a guard that
 * deliberately raises a SQL error on a zero-row result. D1.batch then rolls
 * back the complete request + wallet + ledger transaction.
 */
export async function updateWithdrawalWithD1(
  d1: D1Database,
  input: Input,
): Promise<boolean> {
  const at = input.at.toISOString();
  const assertOneChange = () =>
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();

  if (input.action === "APPROVED") {
    const result = await d1.batch([
      d1.prepare(`
        UPDATE "WithdrawalRequest"
        SET "status" = 'APPROVED', "reviewerId" = ?, "adminNotes" = ?
        WHERE "id" = ? AND "status" = 'REQUESTED' AND "financialUnitStatus" = 'VERIFIED_IRR'
          AND "amount" > 0 AND "amount" = CAST("amount" AS INTEGER) AND abs("amount") <= 9007199254740991
          AND EXISTS (SELECT 1 FROM "Wallet" w WHERE w."id" = "WithdrawalRequest"."walletId" AND w."financialUnitStatus" = 'VERIFIED_IRR')
          AND EXISTS (
            SELECT 1 FROM "WalletLedger" l
            WHERE l."idempotencyKey" = 'withdrawal:' || "WithdrawalRequest"."idempotencyKey" || ':LEDGER'
              AND l."walletId" = "WithdrawalRequest"."walletId"
              AND l."financialUnitStatus" = 'VERIFIED_IRR'
              AND l."type" = 'WITHDRAWAL'
              AND l."amount" = -"WithdrawalRequest"."amount"
              AND l."referenceType" = 'Withdrawal'
              AND l."referenceId" = "WithdrawalRequest"."id"
              AND l."balanceBefore" = CAST(l."balanceBefore" AS INTEGER)
              AND abs(l."balanceBefore") <= 9007199254740991
              AND l."balanceBefore" >= "WithdrawalRequest"."amount"
              AND l."balanceAfter" = CAST(l."balanceAfter" AS INTEGER)
              AND abs(l."balanceAfter") <= 9007199254740991
              AND l."balanceAfter" >= 0
              AND l."balanceAfter" = l."balanceBefore" - "WithdrawalRequest"."amount"
          )
      `).bind(input.adminId, input.adminNotes, input.withdrawalId),
    ]);
    return result[0]?.meta?.changes === 1;
  }

  if (input.action === "REJECTED") {
    const statements = [
      d1.prepare(`
        UPDATE "WithdrawalRequest"
        SET "status" = 'REJECTED', "reviewerId" = ?, "adminNotes" = ?, "processedAt" = ?
        WHERE "id" = ? AND "status" IN ('REQUESTED', 'APPROVED') AND "financialUnitStatus" = 'VERIFIED_IRR'
          AND "amount" > 0 AND "amount" = CAST("amount" AS INTEGER) AND abs("amount") <= 9007199254740991
          AND EXISTS (SELECT 1 FROM "Wallet" w WHERE w."id" = "WithdrawalRequest"."walletId" AND w."financialUnitStatus" = 'VERIFIED_IRR')
          AND EXISTS (
            SELECT 1 FROM "WalletLedger" l
            WHERE l."idempotencyKey" = 'withdrawal:' || "WithdrawalRequest"."idempotencyKey" || ':LEDGER'
              AND l."walletId" = "WithdrawalRequest"."walletId"
              AND l."financialUnitStatus" = 'VERIFIED_IRR'
              AND l."type" = 'WITHDRAWAL'
              AND l."amount" = -"WithdrawalRequest"."amount"
              AND l."referenceType" = 'Withdrawal'
              AND l."referenceId" = "WithdrawalRequest"."id"
              AND l."balanceBefore" = CAST(l."balanceBefore" AS INTEGER)
              AND abs(l."balanceBefore") <= 9007199254740991
              AND l."balanceBefore" >= "WithdrawalRequest"."amount"
              AND l."balanceAfter" = CAST(l."balanceAfter" AS INTEGER)
              AND abs(l."balanceAfter") <= 9007199254740991
              AND l."balanceAfter" >= 0
              AND l."balanceAfter" = l."balanceBefore" - "WithdrawalRequest"."amount"
          )
      `).bind(input.adminId, input.adminNotes, at, input.withdrawalId),
      assertOneChange(),
      d1.prepare(`
        UPDATE "Wallet"
        SET "balance" = "balance" + (
          SELECT "amount" FROM "WithdrawalRequest"
          WHERE "id" = ? AND "status" = 'REJECTED' AND "processedAt" = ?
        ), "updatedAt" = ?
        WHERE "id" = (
          SELECT "walletId" FROM "WithdrawalRequest"
          WHERE "id" = ? AND "status" = 'REJECTED' AND "processedAt" = ?
        ) AND "financialUnitStatus" = 'VERIFIED_IRR'
          AND "balance" = CAST("balance" AS INTEGER) AND "balance" >= 0
          AND "balance" <= 9007199254740991 - (SELECT "amount" FROM "WithdrawalRequest" WHERE "id" = ? AND "status" = 'REJECTED' AND "processedAt" = ?)
          AND changes() = 1
      `).bind(input.withdrawalId, at, at, input.withdrawalId, at, input.withdrawalId, at),
      assertOneChange(),
      d1.prepare(`
        INSERT INTO "WalletLedger"
          ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
           "referenceType", "referenceId", "description", "idempotencyKey", "createdBy", "createdAt", "financialUnitStatus")
        SELECT ?, wr."walletId", 'REFUND',
               CASE WHEN changes() = 1 THEN wr."amount" ELSE NULL END,
               (SELECT "balance" FROM "Wallet" WHERE "id" = wr."walletId") - wr."amount",
               (SELECT "balance" FROM "Wallet" WHERE "id" = wr."walletId"),
               'Withdrawal', wr."id", ?, ?, ?, ?, 'VERIFIED_IRR'
        FROM "WithdrawalRequest" wr
        WHERE wr."id" = ? AND wr."status" = 'REJECTED' AND wr."processedAt" = ?
      `).bind(
        crypto.randomUUID(),
        `Refund for rejected withdrawal ${input.withdrawalId}`,
        `withdrawal:${input.withdrawalId}:REJECT_REFUND`,
        input.adminId,
        at,
        input.withdrawalId,
        at,
      ),
      assertOneChange(),
    ];
    try {
      const results = await d1.batch(statements);
      return [0, 2, 4].every((index) => results[index]?.meta?.changes === 1);
    } catch (error) {
      if (error instanceof Error && /malformed JSON/i.test(error.message)) return false;
      throw error;
    }
  }

  const payoutReference = input.payoutReference?.trim();
  if (!payoutReference || payoutReference.length < 3 || payoutReference.length > 128) {
    throw new Error("شناسه پیگیری واقعی انتقال بانکی الزامی است");
  }
  const payoutId = crypto.randomUUID();
  const statements = [
    d1.prepare(`
      UPDATE "WithdrawalRequest"
      SET "status" = 'PAID', "reviewerId" = ?, "adminNotes" = ?,
          "processedAt" = ?, "txnId" = ?
      WHERE "id" = ? AND "status" = 'APPROVED' AND "financialUnitStatus" = 'VERIFIED_IRR'
        AND "amount" > 0 AND "amount" = CAST("amount" AS INTEGER) AND abs("amount") <= 9007199254740991
        AND EXISTS (SELECT 1 FROM "Wallet" w WHERE w."id" = "WithdrawalRequest"."walletId" AND w."financialUnitStatus" = 'VERIFIED_IRR')
          AND EXISTS (
            SELECT 1 FROM "WalletLedger" l
            WHERE l."idempotencyKey" = 'withdrawal:' || "WithdrawalRequest"."idempotencyKey" || ':LEDGER'
              AND l."walletId" = "WithdrawalRequest"."walletId"
              AND l."financialUnitStatus" = 'VERIFIED_IRR'
              AND l."type" = 'WITHDRAWAL'
              AND l."amount" = -"WithdrawalRequest"."amount"
              AND l."referenceType" = 'Withdrawal'
              AND l."referenceId" = "WithdrawalRequest"."id"
              AND l."balanceBefore" = CAST(l."balanceBefore" AS INTEGER)
              AND abs(l."balanceBefore") <= 9007199254740991
              AND l."balanceBefore" >= "WithdrawalRequest"."amount"
              AND l."balanceAfter" = CAST(l."balanceAfter" AS INTEGER)
              AND abs(l."balanceAfter") <= 9007199254740991
              AND l."balanceAfter" >= 0
              AND l."balanceAfter" = l."balanceBefore" - "WithdrawalRequest"."amount"
          )
    `).bind(input.adminId, input.adminNotes, at, payoutReference, input.withdrawalId),
    assertOneChange(),
    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "kind", "status", "grossAmount", "commissionAmount",
         "netAmount", "description", "idempotencyKey", "createdAt", "financialUnitStatus")
      SELECT ?, wr."walletId", 'PAYOUT', 'COMPLETED',
             CASE WHEN changes() = 1 THEN wr."amount" ELSE NULL END, 0,
             -wr."amount", ?, ?, ?, 'VERIFIED_IRR'
      FROM "WithdrawalRequest" wr
      WHERE wr."id" = ? AND wr."status" = 'PAID' AND wr."txnId" = ?
    `).bind(
      payoutId,
      `Payout for withdrawal ${input.withdrawalId}; bank reference ${payoutReference}`,
      `withdrawal:${input.withdrawalId}:PAYOUT`,
      at,
      input.withdrawalId,
      payoutReference,
    ),
    assertOneChange(),
    d1.prepare(`
      UPDATE "Wallet"
      SET "totalWithdrawn" = "totalWithdrawn" + CASE WHEN changes() = 1 THEN (
        SELECT "amount" FROM "WithdrawalRequest"
        WHERE "id" = ? AND "status" = 'PAID' AND "txnId" = ?
      ) ELSE NULL END, "updatedAt" = ?
      WHERE "id" = (
        SELECT "walletId" FROM "WithdrawalRequest"
        WHERE "id" = ? AND "status" = 'PAID' AND "txnId" = ?
      ) AND "financialUnitStatus" = 'VERIFIED_IRR'
        AND "totalWithdrawn" = CAST("totalWithdrawn" AS INTEGER) AND "totalWithdrawn" >= 0 AND "totalWithdrawn" <= 9007199254740991
        AND "totalWithdrawn" <= 9007199254740991 - (SELECT "amount" FROM "WithdrawalRequest" WHERE "id" = ? AND "status" = 'PAID' AND "txnId" = ?)
        AND changes() = 1
    `).bind(input.withdrawalId, payoutReference, at, input.withdrawalId, payoutReference, input.withdrawalId, payoutReference),
    assertOneChange(),
  ];
  try {
    const results = await d1.batch(statements);
    return [0, 2, 4].every((index) => results[index]?.meta?.changes === 1);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return false;
    throw error;
  }
}

export async function updateWithdrawalAtomically(
  db: PrismaClient,
  input: Input,
): Promise<boolean> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return updateWithdrawalWithPrisma(db, input);

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  const d1 = (context.env as unknown as { DB?: D1Database }).DB;
  if (!d1) throw new Error("D1 binding 'DB' is unavailable for admin withdrawal action");
  return updateWithdrawalWithD1(d1, input);
}
