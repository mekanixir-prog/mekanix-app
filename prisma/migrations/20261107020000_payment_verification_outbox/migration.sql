CREATE TABLE "PaymentOutboxEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" DATETIME,
  "processedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PaymentOutboxEvent_idempotencyKey_key" ON "PaymentOutboxEvent"("idempotencyKey");
CREATE INDEX "PaymentOutboxEvent_status_availableAt_idx" ON "PaymentOutboxEvent"("status", "availableAt");
CREATE INDEX "PaymentOutboxEvent_aggregateType_aggregateId_createdAt_idx" ON "PaymentOutboxEvent"("aggregateType", "aggregateId", "createdAt");
