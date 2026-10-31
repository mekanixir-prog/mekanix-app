ALTER TABLE "WithdrawalRequest" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "WithdrawalRequest_idempotencyKey_key" ON "WithdrawalRequest"("idempotencyKey");
