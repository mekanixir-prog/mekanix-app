-- Make VIP gateway initiation retry-safe. Historical rows remain NULL.
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "PaymentGatewayLog_idempotencyKey_key" ON "PaymentGatewayLog"("idempotencyKey");
