export type D1Result = { meta?: { changes?: number } };
export type D1PreparedStatement = { bind: (...values: unknown[]) => D1PreparedStatement };
export type D1Binding = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

/**
 * D1 batch is a single SQLite transaction. The wallet aggregate is changed
 * first, then each required write is followed by an assertion that exactly one
 * row changed. The assertion deliberately raises a SQL error on zero rows, so
 * D1 rolls back the entire batch instead of committing a partial transfer.
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
    WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING' AND "netAmount" >= 0
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
        WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING' AND "netAmount" >= 0
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
    WHERE "id" = ? AND "walletId" = ? AND "status" = 'PENDING' AND "netAmount" >= 0
      AND "holdUntil" IS NOT NULL AND "holdUntil" <= ?
      AND changes() = 1
  `).bind(timestamp, transactionId, walletId, timestamp);

  const ledgerInsert = d1.prepare(`
    INSERT INTO "WalletLedger"
      ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
       "referenceType", "referenceId", "description", "idempotencyKey", "createdAt")
    SELECT ?, w."id", 'RELEASE', wt."netAmount",
           w."balance" - wt."netAmount", w."balance",
           'WalletTransaction', wt."id", ?, ?, ?
    FROM "Wallet" w
    JOIN "WalletTransaction" wt ON wt."walletId" = w."id"
    WHERE w."id" = ? AND wt."id" = ? AND wt."status" = 'AVAILABLE'
      AND wt."releasedAt" = ? AND changes() = 1
  `).bind(
    crypto.randomUUID(),
    `Escrow released — transaction ${transactionId}`,
    `wallet-release:${transactionId}:LEDGER`,
    timestamp,
    walletId,
    transactionId,
    timestamp
  );

  // Use NOT NULL columns as rollback assertions instead of SELECT changes().
  // D1/SQLite adapters may reset changes() when reading a SELECT result; these
  // no-op UPDATEs preserve the counter for the next guarded write and force a
  // constraint error if the immediately preceding required mutation changed
  // zero rows. The entire D1 batch then rolls back.
  const walletAssertAfterDebit = d1.prepare(`
    UPDATE "Wallet"
    SET "balance" = CASE WHEN changes() = 1 THEN "balance" ELSE NULL END
    WHERE "id" = ?
  `).bind(walletId);

  const transactionAssertAfterTransition = d1.prepare(`
    UPDATE "WalletTransaction"
    SET "status" = CASE WHEN changes() = 1 THEN "status" ELSE NULL END
    WHERE "id" = ?
  `).bind(transactionId);

  const walletAssertAfterLedger = d1.prepare(`
    UPDATE "Wallet"
    SET "balance" = CASE WHEN changes() = 1 THEN "balance" ELSE NULL END
    WHERE "id" = ?
  `).bind(walletId);

  const results = await d1.batch([
    walletUpdate,
    walletAssertAfterDebit,
    transactionUpdate,
    transactionAssertAfterTransition,
    ledgerInsert,
    walletAssertAfterLedger,
  ]);
  return results[0]?.meta?.changes === 1 &&
    results[2]?.meta?.changes === 1 &&
    results[4]?.meta?.changes === 1;
}
