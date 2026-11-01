ALTER TABLE "ServiceBooking" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ServiceBooking" ADD COLUMN "requestFingerprint" TEXT;
CREATE UNIQUE INDEX "ServiceBooking_idempotencyKey_key" ON "ServiceBooking"("idempotencyKey");

ALTER TABLE "ServiceTimelineEvent" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "ServiceTimelineEvent_idempotencyKey_key" ON "ServiceTimelineEvent"("idempotencyKey");
