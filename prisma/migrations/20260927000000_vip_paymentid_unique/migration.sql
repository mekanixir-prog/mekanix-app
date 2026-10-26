-- MEKANIX — SQLite/D1 migration: add unique constraint on UserVipSubscription.paymentId
-- VIP-01 fix: prevents TOCTOU race where two concurrent subscribes with the
-- same paymentId both pass the findFirst check and both call create.
--
-- Safety: before creating the unique index, we delete any duplicate
-- paymentId rows (keeping only the most recent one per paymentId).
-- This ensures the migration succeeds even if the DB already has
-- duplicate paymentId values from before the constraint existed.
-- NULL paymentIds are allowed (multiple subs can have no payment linked).

-- Step 1: Delete duplicate rows (keep the one with the latest createdAt)
DELETE FROM "UserVipSubscription"
WHERE "paymentId" IS NOT NULL
  AND "id" NOT IN (
    SELECT MAX("id") FROM "UserVipSubscription"
    WHERE "paymentId" IS NOT NULL
    GROUP BY "paymentId"
  );

-- Step 2: Create the unique index (only non-NULL values are enforced)
CREATE UNIQUE INDEX "UserVipSubscription_paymentId_key" ON "UserVipSubscription"("paymentId");
