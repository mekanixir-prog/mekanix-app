-- Add nullable idempotency keys to financial records.
-- Existing rows remain untouched; NULL preserves historical records while
-- unique indexes protect all records written by the new atomic flows.
ALTER TABLE "WalletTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key"
  ON "WalletTransaction"("idempotencyKey");

ALTER TABLE "WalletLedger" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "WalletLedger_idempotencyKey_key"
  ON "WalletLedger"("idempotencyKey");
