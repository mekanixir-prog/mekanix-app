-- MEKANIX — PostgreSQL migration: add unique constraint on UserVipSubscription.paymentId
-- VIP-01 fix: prevents TOCTOU race where two concurrent subscribes with the
-- same paymentId both pass the findFirst check and both call create.
--
-- Safety: before creating the unique index, we delete any duplicate
-- paymentId rows (keeping only the most recent one per paymentId).
-- NULL paymentIds are allowed (PostgreSQL allows multiple NULLs in unique).

-- Step 1: Delete duplicate rows (keep the one with the latest createdAt)
DELETE FROM "UserVipSubscription"
WHERE "paymentId" IS NOT NULL
  AND "id" NOT IN (
    SELECT MAX("id") FROM "UserVipSubscription"
    WHERE "paymentId" IS NOT NULL
    GROUP BY "paymentId"
  );

-- Step 2: Create the unique index
CREATE UNIQUE INDEX "UserVipSubscription_paymentId_key" ON "UserVipSubscription"("paymentId");
