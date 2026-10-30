import type { PrismaClient } from "@prisma/client";

type D1Result = { meta?: { changes?: number } };
type D1PreparedStatement = { bind: (...values: unknown[]) => D1PreparedStatement };
type D1Binding = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

/**
 * D1's batch API runs all statements in one SQLite transaction.
 * The wallet aggregate is changed first; the transaction transition is
 * conditioned on SQLite changes() from that exact wallet UPDATE. Both
 * statements use the same eligibility predicate and the batch is atomic.
 */
export async function releaseWalletTransactionWithD1(
  d1: D1Binding,
  walletId: string,
  transactionId: string,
  now: Date
): Promise<boolean> {
  const timestamp = now.toISOString();
  const eligibleAmount = `(
    SELECT "netAmount" FROM "WalletTransaction"
    WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING'
      AND "holdUntil" IS NOT NULL AND "holdUntil" <= ?
  )`;

  const walletUpdate = d1.prepare(`
    UPDATE "Wallet"
    SET
      "pendingBalance" = "pendingBalance" - ${eligibleAmount},
      "balance" = "balance" + ${eligibleAmount},
      "updatedAt" = ?
    WHERE "id" = ?
      AND "pendingBalance" >= ${eligibleAmount}
      AND EXISTS (
        SELECT 1 FROM "WalletTransaction"
        WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING'
          AND "holdUntil" IS NOT NULL AND "holdUntil" <= ?
      )
  `).bind(
    transactionId, walletId, timestamp,
    transactionId, walletId, timestamp,
    timestamp, walletId,
    transactionId, walletId, timestamp,
    transactionId, walletId, timestamp
  );

  const transactionUpdate = d1.prepare(`
    UPDATE "WalletTransaction"
    SET "status" = 'AVAILABLE', "releasedAt" = ?
    WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING'
      AND "holdUntil" IS NOT NULL AND "holdUntil" <= ?
      AND changes() = 1
  `).bind(timestamp, transactionId, walletId, timestamp);

  const results = await d1.batch([walletUpdate, transactionUpdate]);
  return results[0]?.meta?.changes === 1 && results[1]?.meta?.changes === 1;
}

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
