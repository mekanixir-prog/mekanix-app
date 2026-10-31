import type { PrismaClient } from "@prisma/client";
import { releaseWalletTransactionWithD1, type D1Binding } from "./wallet-release-d1";
export { releaseWalletTransactionWithD1 } from "./wallet-release-d1";

/** Node/SQLite and PostgreSQL implementation using a real Prisma transaction. */
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
        holdUntil: { not: null, lte: now },
      },
      select: { netAmount: true },
    });
    if (!transaction) return false;

    const transition = await tx.walletTransaction.updateMany({
      where: {
        id: transactionId,
        walletId,
        status: "PENDING",
        holdUntil: { not: null, lte: now },
      },
      data: { status: "AVAILABLE", releasedAt: now },
    });
    if (transition.count !== 1) return false;

    const walletUpdate = await tx.wallet.updateMany({
      where: { id: walletId, pendingBalance: { gte: transaction.netAmount } },
      data: {
        pendingBalance: { decrement: transaction.netAmount },
        balance: { increment: transaction.netAmount },
      },
    });

    if (walletUpdate.count !== 1) {
      // Throwing rolls back the preceding PENDING -> AVAILABLE transition.
      throw new Error("Wallet pending balance is inconsistent; escrow release rolled back");
    }
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
