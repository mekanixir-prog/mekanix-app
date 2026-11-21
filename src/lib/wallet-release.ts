import type { PrismaClient } from "@prisma/client";
import { toSafeIntegerIrr } from "./money/provenance";
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
        netAmount: { gt: 0 },
        holdUntil: { not: null, lte: now },
      },
      select: { netAmount: true },
    });
    if (!transaction) return false;

    const amount = toSafeIntegerIrr(transaction.netAmount);
    if (amount === null || amount <= 0) return false;

    const walletBefore = await tx.wallet.findUnique({
      where: { id: walletId },
      select: { financialUnitStatus: true, balance: true, pendingBalance: true },
    });
    if (!walletBefore || walletBefore.financialUnitStatus !== "VERIFIED_IRR") return false;
    const balanceBefore = toSafeIntegerIrr(walletBefore.balance);
    const pendingBefore = toSafeIntegerIrr(walletBefore.pendingBalance);
    if (balanceBefore === null || pendingBefore === null ||
        pendingBefore < amount || balanceBefore + amount > Number.MAX_SAFE_INTEGER) return false;

    const transition = await tx.walletTransaction.updateMany({
      where: {
        id: transactionId,
        walletId,
        status: "PENDING",
        financialUnitStatus: "VERIFIED_IRR",
        netAmount: transaction.netAmount,
        holdUntil: { not: null, lte: now },
      },
      data: { status: "AVAILABLE", releasedAt: now },
    });
    if (transition.count !== 1) return false;

    const walletUpdate = await tx.wallet.updateMany({
      where: {
        id: walletId,
        financialUnitStatus: "VERIFIED_IRR",
        balance: walletBefore.balance,
        pendingBalance: walletBefore.pendingBalance,
      },
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
      select: { financialUnitStatus: true, balance: true, pendingBalance: true },
    });
    if (!updatedWallet || updatedWallet.financialUnitStatus !== "VERIFIED_IRR") {
      throw new Error("Wallet disappeared or lost verified IRR provenance during escrow release");
    }
    const balanceAfter = toSafeIntegerIrr(updatedWallet.balance);
    const pendingAfter = toSafeIntegerIrr(updatedWallet.pendingBalance);
    if (balanceAfter !== balanceBefore + amount || pendingAfter !== pendingBefore - amount) {
      throw new Error("Wallet aggregates are not safe integer IRR after escrow release; transaction rolled back");
    }

    await tx.walletLedger.create({
      data: {
        walletId,
        financialUnitStatus: "VERIFIED_IRR",
        type: "RELEASE",
        amount,
        balanceBefore: walletBefore.balance,
        balanceAfter: updatedWallet.balance,
        referenceType: "WalletTransaction",
        referenceId: transactionId,
        description: `Escrow released — transaction ${transactionId}`,
        idempotencyKey: `wallet-release:${transactionId}:LEDGER`,
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
