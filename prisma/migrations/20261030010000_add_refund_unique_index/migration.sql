-- MEKANIX — Add partial unique index to prevent double-refund
--
-- CRITICAL: This migration adds a DB-level constraint that makes it
-- impossible to create two REFUND ledger entries for the same withdrawal.
-- Even if two concurrent requests try to refund the same withdrawal,
-- only one INSERT will succeed — the other gets a unique constraint
-- violation (P2002).
--
-- PREFLIGHT CHECK:
-- Before creating the index, we check for existing duplicate REFUND
-- entries. If duplicates exist, the migration MUST fail — we never
-- auto-delete financial records. The operator must manually reconcile.
--
-- SQLite does not support procedural IF/THEN in migration SQL, so we
-- use a CREATE INDEX that will fail if duplicates exist. The index
-- creation itself is the guard: if duplicate referenceId values exist
-- for REFUND + Withdrawal rows, the CREATE UNIQUE INDEX will fail with
-- "UNIQUE constraint failed".
--
-- To preview duplicates BEFORE running this migration, run:
--   SELECT "referenceId", COUNT(*) as cnt
--   FROM "WalletLedger"
--   WHERE "type" = 'REFUND' AND "referenceType" = 'Withdrawal'
--     AND "referenceId" IS NOT NULL
--   GROUP BY "referenceId"
--   HAVING COUNT(*) > 1;
-- If any rows are returned, reconcile them manually before proceeding.

-- Create the partial unique index.
-- This statement will FAIL if duplicate (referenceId, type='REFUND',
-- referenceType='Withdrawal') rows exist — which is exactly what we want.
-- We do NOT delete duplicates automatically.
CREATE UNIQUE INDEX IF NOT EXISTS "WalletLedger_refund_unique_per_withdrawal"
ON "WalletLedger"("referenceId")
WHERE "type" = 'REFUND' AND "referenceType" = 'Withdrawal';
