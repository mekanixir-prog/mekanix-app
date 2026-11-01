ALTER TABLE "ServiceRequest" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ServiceRequest" ADD COLUMN "requestFingerprint" TEXT;
CREATE UNIQUE INDEX "ServiceRequest_idempotencyKey_key" ON "ServiceRequest"("idempotencyKey");

ALTER TABLE "InsuranceClaim" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "InsuranceClaim" ADD COLUMN "requestFingerprint" TEXT;
CREATE UNIQUE INDEX "InsuranceClaim_idempotencyKey_key" ON "InsuranceClaim"("idempotencyKey");
