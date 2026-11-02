export type D1Result = { meta?: { changes?: number } };
export type D1PreparedStatement = { bind: (...values: unknown[]) => D1PreparedStatement };
export type D1Binding = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

/**
 * D1 batch is a single SQLite transaction. The wallet aggregate is changed
 * first; the transaction transition is conditioned on changes() from that
 * exact wallet UPDATE; the RELEASE ledger proof is conditioned on changes()
 * from the transaction transition. Any ledger conflict aborts the whole batch.
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

  // A conditional UPDATE/INSERT that affects zero rows is still valid SQL
  // and does not abort D1.batch. Force a statement error after every required
  // mutation so a zero-row result rolls the entire batch back, not just the
  // final returned boolean.
  const assertOneChange = () => d1.prepare(`
    SELECT CASE
      WHEN changes() = 1 THEN 1
      ELSE json_extract('not-json', '
}
)
    END
  `).bind();

  const results = await d1.batch([
    walletUpdate,
    assertOneChange(),
    transactionUpdate,
    assertOneChange(),
    ledgerInsert,
    assertOneChange(),
  ]);
  return results[0]?.meta?.changes === 1 &&
    results[2]?.meta?.changes === 1 &&
    results[4]?.meta?.changes === 1;
}
