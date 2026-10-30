export type D1Result = { meta?: { changes?: number } };
export type D1PreparedStatement = { bind: (...values: unknown[]) => D1PreparedStatement };
export type D1Binding = {
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
    transactionId, walletId, timestamp,
    timestamp, walletId,
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

