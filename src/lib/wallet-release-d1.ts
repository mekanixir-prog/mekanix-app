export type D1Result = { meta?: { changes?: number } };
export type D1PreparedStatement = { bind: (...values: unknown[]) => D1PreparedStatement };
export type D1Binding = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

/**
 * Release an escrowed wallet transaction in one D1 batch.
 *
 * The RELEASE ledger row is inserted first and records the wallet's expected
 * before/after balance. The aggregate update is conditional on that exact
 * ledger proof; the transaction transition is conditional on the aggregate
 * having reached the recorded after-balance. A final NOT NULL assertion makes
 * any partial/ignored write abort the whole batch. This deliberately avoids
 * SQLite changes() because its value is not reliable inside a subsequent
 * statement's expressions across the D1 and node:sqlite execution paths.
 */
export async function releaseWalletTransactionWithD1(
  d1: D1Binding,
  walletId: string,
  transactionId: string,
  now: Date
): Promise<boolean> {
  const timestamp = now.toISOString();
  const idempotencyKey = `wallet-release:${transactionId}:LEDGER`;
  const eligible = `
    wt."id" = ? AND wt."walletId" = ? AND wt."status" = 'PENDING' AND wt."financialUnitStatus" = 'VERIFIED_IRR'
    AND wt."netAmount" >= 0 AND wt."holdUntil" IS NOT NULL AND wt."holdUntil" <= ?
  `;

  const ledgerInsert = d1.prepare(`
    INSERT INTO "WalletLedger"
      ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
       "referenceType", "referenceId", "description", "idempotencyKey", "createdAt")
    SELECT ?, w."id", 'RELEASE', wt."netAmount", w."balance",
           w."balance" + wt."netAmount",
           'WalletTransaction', wt."id", ?, ?, ?, 'VERIFIED_IRR'
    FROM "Wallet" w
    JOIN "WalletTransaction" wt ON wt."walletId" = w."id"
    WHERE ${eligible}
      AND w."id" = ?
      AND w."pendingBalance" >= wt."netAmount"
      AND NOT EXISTS (
        SELECT 1 FROM "WalletLedger" existing
        WHERE existing."idempotencyKey" = ?
      )
  `).bind(
    crypto.randomUUID(),
    transactionId,
    idempotencyKey,
    timestamp,
    transactionId, walletId, timestamp,
    walletId,
    idempotencyKey
  );

  const walletUpdate = d1.prepare(`
    UPDATE "Wallet" AS w
    SET
      "pendingBalance" = "pendingBalance" - (
        SELECT wt."netAmount" FROM "WalletTransaction" wt
        WHERE wt."id" = ? AND wt."walletId" = w."id"
      ),
      "balance" = "balance" + (
        SELECT wt."netAmount" FROM "WalletTransaction" wt
        WHERE wt."id" = ? AND wt."walletId" = w."id"
      ),
      "updatedAt" = ?
    WHERE w."id" = ? AND w."financialUnitStatus" = 'VERIFIED_IRR'
      AND EXISTS (
        SELECT 1
        FROM "WalletTransaction" wt
        JOIN "WalletLedger" ledger
          ON ledger."referenceId" = wt."id"
         AND ledger."idempotencyKey" = ?
        WHERE wt."id" = ? AND wt."walletId" = w."id"
          AND wt."status" = 'PENDING' AND wt."financialUnitStatus" = 'VERIFIED_IRR' AND wt."netAmount" >= 0
          AND wt."holdUntil" IS NOT NULL AND wt."holdUntil" <= ?
          AND w."pendingBalance" >= wt."netAmount"
          AND ledger."balanceBefore" = w."balance"
          AND ledger."balanceAfter" = w."balance" + wt."netAmount"
      )
  `).bind(
    transactionId, transactionId, timestamp, walletId,
    idempotencyKey, transactionId, timestamp
  );

  const transactionUpdate = d1.prepare(`
    UPDATE "WalletTransaction" AS wt
    SET "status" = 'AVAILABLE', "releasedAt" = ?
    WHERE ${eligible}
      AND EXISTS (
        SELECT 1
        FROM "Wallet" w
        JOIN "WalletLedger" ledger
          ON ledger."walletId" = w."id"
         AND ledger."referenceId" = wt."id"
         AND ledger."idempotencyKey" = ?
        WHERE w."id" = wt."walletId"
          AND w."balance" = ledger."balanceAfter"
      )
  `).bind(timestamp, transactionId, walletId, timestamp, idempotencyKey);

  // A dedicated guard row is used because SQLite may ignore an UPDATE
  // assertion when a trigger suppresses writes to WalletTransaction itself.
  // Its NOT NULL passed field aborts the batch if any required state is
  // missing. The row is deleted before commit and is never durable state.
  const guardId = `wallet-release-assert:${crypto.randomUUID()}`;
  const finalAssertion = d1.prepare(`
    INSERT INTO "WalletReleaseGuard" ("id", "passed", "createdAt")
    VALUES (
      ?,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM "WalletTransaction"
          WHERE "id" = ? AND "status" IN ('PENDING', 'AVAILABLE')
        ) OR EXISTS (
          SELECT 1
          FROM "WalletTransaction" wt
          JOIN "Wallet" w ON w."id" = wt."walletId"
          JOIN "WalletLedger" ledger
            ON ledger."walletId" = w."id"
           AND ledger."referenceId" = wt."id"
           AND ledger."idempotencyKey" = ?
          WHERE wt."id" = ? AND wt."status" = 'AVAILABLE' AND wt."financialUnitStatus" = 'VERIFIED_IRR'
            AND w."balance" = ledger."balanceAfter"
        ) THEN 1
        ELSE NULL
      END,
      ?
    )
  `).bind(guardId, transactionId, idempotencyKey, transactionId, timestamp);

  const guardCleanup = d1.prepare(`
    DELETE FROM "WalletReleaseGuard" WHERE "id" = ?
  `).bind(guardId);

  const results = await d1.batch([
    ledgerInsert,
    walletUpdate,
    transactionUpdate,
    finalAssertion,
    guardCleanup,
  ]);

  return results[0]?.meta?.changes === 1 &&
    results[1]?.meta?.changes === 1 &&
    results[2]?.meta?.changes === 1;
}
