CREATE TABLE "PaymentOutboxEvent" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentOutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentOutboxEvent_idempotencyKey_key" ON "PaymentOutboxEvent"("idempotencyKey");
CREATE INDEX "PaymentOutboxEvent_status_availableAt_idx" ON "PaymentOutboxEvent"("status", "availableAt");
CREATE INDEX "PaymentOutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "PaymentOutboxEvent"("aggregateType", "aggregateId", "createdAt");
