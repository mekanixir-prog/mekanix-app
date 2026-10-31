import type { PrismaClient } from "@prisma/client";

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

/** All admin financial transitions run with the related wallet/ledger writes in one transaction. */
export async function updateWithdrawalWithPrisma(db: PrismaClient, input: Input): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawalRequest.findUnique({
      where: { id: input.withdrawalId },
      select: { id: true, walletId: true, amount: true, status: true },
    });
    if (!withdrawal) throw new Error("درخواست برداشت پیدا نشد");

    if (input.action === "APPROVED") {
      if (withdrawal.status !== "REQUESTED") return false;
      const result = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawal.id, status: "REQUESTED" },
        data: { status: "APPROVED", reviewerId: input.adminId, adminNotes: input.adminNotes },
      });
      return result.count === 1;
    }

    if (input.action === "REJECTED") {
      if (withdrawal.status !== "REQUESTED" && withdrawal.status !== "APPROVED") return false;
      const transition = await tx.withdrawalRequest.updateMany({
        where: { id: withdrawal.id, status: { in: ["REQUESTED", "APPROVED"] } },
        data: {
          status: "REJECTED",
          reviewerId: input.adminId,
          adminNotes: input.adminNotes,
          processedAt: input.at,
        },
      });
      if (transition.count !== 1) return false;

      const walletUpdate = await tx.wallet.updateMany({
        where: { id: withdrawal.walletId },
        data: { balance: { increment: withdrawal.amount } },
      });
      if (walletUpdate.count !== 1) {
        throw new Error("کیف پول برای بازگشت مبلغ پیدا نشد؛ عملیات لغو شد");
      }
      const wallet = await tx.wallet.findUnique({
        where: { id: withdrawal.walletId },
        select: { balance: true },
      });
      if (!wallet) throw new Error("کیف پول پس از بازگشت وجه پیدا نشد");

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
      where: { id: withdrawal.id, status: "APPROVED" },
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
      },
    });
    const walletUpdate = await tx.wallet.updateMany({
      where: { id: withdrawal.walletId },
      data: { totalWithdrawn: { increment: withdrawal.amount } },
    });
    if (walletUpdate.count !== 1) throw new Error("کیف پول برای ثبت پرداخت پیدا نشد؛ عملیات لغو شد");
    return true;
  });
}

/** Cloudflare D1: conditional transitions and dependent writes share one transactional batch. */
export async function updateWithdrawalWithD1(d1: D1Database, input: Input): Promise<boolean> {
  const at = input.at.toISOString();

  if (input.action === "APPROVED") {
    const result = await d1.batch([
      d1.prepare(`
        UPDATE "WithdrawalRequest"
        SET "status" = 'APPROVED', "reviewerId" = ?, "adminNotes" = ?
        WHERE "id" = ? AND "status" = 'REQUESTED'
      `).bind(input.adminId, input.adminNotes, input.withdrawalId),
    ]);
    return result[0]?.meta?.changes === 1;
  }

  if (input.action === "REJECTED") {
    const results = await d1.batch([
      d1.prepare(`
        UPDATE "WithdrawalRequest"
        SET "status" = 'REJECTED', "reviewerId" = ?, "adminNotes" = ?, "processedAt" = ?
        WHERE "id" = ? AND "status" IN ('REQUESTED', 'APPROVED')
      `).bind(input.adminId, input.adminNotes, at, input.withdrawalId),
      d1.prepare(`
        UPDATE "Wallet"
        SET "balance" = "balance" + (
          SELECT "amount" FROM "WithdrawalRequest"
          WHERE "id" = ? AND "status" = 'REJECTED' AND "processedAt" = ?
        ), "updatedAt" = ?
        WHERE "id" = (
          SELECT "walletId" FROM "WithdrawalRequest"
          WHERE "id" = ? AND "status" = 'REJECTED' AND "processedAt" = ?
        ) AND changes() = 1
      `).bind(input.withdrawalId, at, at, input.withdrawalId, at),
      d1.prepare(`
        INSERT INTO "WalletLedger"
          ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
           "referenceType", "referenceId", "description", "idempotencyKey", "createdBy", "createdAt")
        SELECT ?, w."id", 'REFUND', wr."amount", w."balance" - wr."amount", w."balance",
               'Withdrawal', wr."id", ?, ?, ?, ?
        FROM "Wallet" w JOIN "WithdrawalRequest" wr ON wr."walletId" = w."id"
        WHERE wr."id" = ? AND wr."status" = 'REJECTED'
          AND wr."processedAt" = ? AND changes() = 1
      `).bind(
        crypto.randomUUID(), `Refund for rejected withdrawal ${input.withdrawalId}`,
        `withdrawal:${input.withdrawalId}:REJECT_REFUND`, input.adminId, at,
        input.withdrawalId, at
      ),
    ]);
    return results[0]?.meta?.changes === 1 &&
      results[1]?.meta?.changes === 1 &&
      results[2]?.meta?.changes === 1;
  }

  const payoutReference = input.payoutReference?.trim();
  if (!payoutReference || payoutReference.length < 3 || payoutReference.length > 128) {
    throw new Error("شناسه پیگیری واقعی انتقال بانکی الزامی است");
  }
  const payoutId = crypto.randomUUID();
  const results = await d1.batch([
    d1.prepare(`
      UPDATE "WithdrawalRequest"
      SET "status" = 'PAID', "reviewerId" = ?, "adminNotes" = ?,
          "processedAt" = ?, "txnId" = ?
      WHERE "id" = ? AND "status" = 'APPROVED'
    `).bind(input.adminId, input.adminNotes, at, payoutReference, input.withdrawalId),
    d1.prepare(`
      INSERT INTO "WalletTransaction"
        ("id", "walletId", "kind", "status", "grossAmount", "commissionAmount",
         "netAmount", "description", "idempotencyKey", "createdAt")
      SELECT ?, wr."walletId", 'PAYOUT', 'COMPLETED', wr."amount", 0,
             -wr."amount", ?, ?, ?
      FROM "WithdrawalRequest" wr
      WHERE wr."id" = ? AND wr."status" = 'PAID' AND wr."txnId" = ? AND changes() = 1
    `).bind(
      payoutId, `Payout for withdrawal ${input.withdrawalId}; bank reference ${payoutReference}`,
      `withdrawal:${input.withdrawalId}:PAYOUT`, at, input.withdrawalId, payoutReference
    ),
    d1.prepare(`
      UPDATE "Wallet"
      SET "totalWithdrawn" = "totalWithdrawn" + (
        SELECT "amount" FROM "WithdrawalRequest"
        WHERE "id" = ? AND "status" = 'PAID' AND "txnId" = ?
      ), "updatedAt" = ?
      WHERE "id" = (
        SELECT "walletId" FROM "WithdrawalRequest"
        WHERE "id" = ? AND "status" = 'PAID' AND "txnId" = ?
      ) AND changes() = 1
    `).bind(input.withdrawalId, payoutId, at, input.withdrawalId, payoutId),
  ]);
  return results[0]?.meta?.changes === 1 &&
    results[1]?.meta?.changes === 1 &&
    results[2]?.meta?.changes === 1;
}

export async function updateWithdrawalAtomically(
  db: PrismaClient,
  input: Input
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
