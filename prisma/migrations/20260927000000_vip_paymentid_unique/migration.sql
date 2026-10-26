-- MEKANIX — SQLite/D1 migration: add unique constraint on UserVipSubscription.paymentId
-- VIP-01 fix: prevents TOCTOU race where two concurrent subscribes with the
-- same paymentId both pass the findFirst check and both create a subscription.
-- The @unique constraint lets the DB reject the second insert atomically.

-- CreateIndex (unique — one subscription per paymentId)
CREATE UNIQUE INDEX "UserVipSubscription_paymentId_key" ON "UserVipSubscription"("paymentId");
