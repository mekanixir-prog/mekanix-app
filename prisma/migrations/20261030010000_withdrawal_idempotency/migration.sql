-- Withdrawal request idempotency. Existing requests remain valid with NULL keys.
ALTER TABLE "WithdrawalRequest" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key"
  ON "WithdrawalRequest"("idempotencyKey");
