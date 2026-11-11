import type { PrismaClient } from "@prisma/client";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";
import { releaseWalletTransactionWithD1, type D1Binding } from "./wallet-release-d1";
export { releaseWalletTransactionWithD1 } from "./wallet-release-d1";

/** Node/SQLite and PostgreSQL: state, aggregates, and immutable ledger proof commit together. */
export async function releaseWalletTransactionWithPrisma(
  db: PrismaClient,
  walletId: string,
  transactionId: string,
  now: Date
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const transaction = await tx.walletTransaction.findFirst({
      where: {
        id: transactionId,
        walletId,
        status: "PENDING",
        financialUnitStatus: "VERIFIED_IRR",
        netAmount: { gte: 0 },
        holdUntil: { not: null, lte: now },
      },
      select: { netAmount: true, financialUnitStatus: true },
    });
    if (!transaction || transaction.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(transaction.netAmount)) return false;

    const transition = await tx.walletTransaction.updateMany({
      where: {
        id: transactionId,
        walletId,
        status: "PENDING",
        financialUnitStatus: "VERIFIED_IRR",
        netAmount: { gte: 0 },
        holdUntil: { not: null, lte: now },
      },
      data: { status: "AVAILABLE", releasedAt: now },
    });
    if (transition.count !== 1) return false;

    const walletUpdate = await tx.wallet.updateMany({
      where: { id: walletId, financialUnitStatus: "VERIFIED_IRR", pendingBalance: { gte: transaction.netAmount } },
      data: {
        pendingBalance: { decrement: transaction.netAmount },
        balance: { increment: transaction.netAmount },
      },
    });

    if (walletUpdate.count !== 1) {
      // Throwing rolls back the preceding PENDING -> AVAILABLE transition.
      throw new Error("Wallet pending balance is inconsistent; escrow release rolled back");
    }

    const updatedWallet = await tx.wallet.findUnique({
      where: { id: walletId },
      select: { balance: true, pendingBalance: true, financialUnitStatus: true },
    });
    if (!updatedWallet || updatedWallet.financialUnitStatus !== "VERIFIED_IRR" ||
        !isSafeStoredIrrAmount(updatedWallet.balance) || Number(updatedWallet.balance) < 0 ||
        !isSafeStoredIrrAmount(updatedWallet.pendingBalance) || Number(updatedWallet.pendingBalance) < 0) {
      throw new Error("Wallet financial provenance or integer IRR aggregates are invalid");
    }

    const amount = transaction.netAmount;
    const balanceAfter = updatedWallet.balance;
    await tx.walletLedger.create({
      data: {
        walletId,
        type: "RELEASE",
        amount,
        balanceBefore: balanceAfter.minus(amount),
        balanceAfter,
        referenceType: "WalletTransaction",
        referenceId: transactionId,
        description: `Escrow released — transaction ${transactionId}`,
        idempotencyKey: `wallet-release:${transactionId}:LEDGER`,
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
    return true;
  });
}

export async function releaseWalletTransaction(
  db: PrismaClient,
  walletId: string,
  transactionId: string,
  now: Date
): Promise<boolean> {
  const isCloudflareWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

  if (isCloudflareWorkers) {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const d1 = (context.env as unknown as { DB?: D1Binding }).DB;
    if (!d1) throw new Error("D1 binding 'DB' is unavailable for atomic escrow release");
    return releaseWalletTransactionWithD1(d1, walletId, transactionId, now);
  }

  return releaseWalletTransactionWithPrisma(db, walletId, transactionId, now);
}
