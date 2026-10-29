-- MEKANIX: IdempotencyKey recovery fields for atomic withdraw idempotency.
--
-- Adds status, requestHash, userId columns to support the atomic-reserve
-- pattern used by /api/wallets/withdraw. D1 has no $transaction; the
-- key @unique constraint plus INSERT-or-P2002 is the atomic primitive.
--
-- Status values: IN_PROGRESS | COMPLETED | FAILED
-- Existing rows (from the old schema) are upgraded to COMPLETED with a
-- sentinel requestHash so they continue to serve cached responses.
--
-- SQLite ALTER TABLE supports adding columns with defaults in-place (no
-- table rebuild). The response column becomes nullable, but old rows
-- already have a value so they remain readable.

ALTER TABLE "IdempotencyKey" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "IdempotencyKey" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT 'legacy-no-hash';
ALTER TABLE "IdempotencyKey" ADD COLUMN "userId" TEXT;
ALTER TABLE "IdempotencyKey" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "IdempotencyKey_userId_status_idx"
ON "IdempotencyKey"("userId", "status");
