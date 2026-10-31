-- One gateway attempt can create at most one payment.
-- Nullable for legacy invoice payments and non-gateway payment flows.
ALTER TABLE "Payment" ADD COLUMN "gatewayLogId" TEXT;
CREATE UNIQUE INDEX "Payment_gatewayLogId_key" ON "Payment"("gatewayLogId");
