-- Keep the newest active VIP subscription per user before enforcing the invariant.
-- Older duplicate ACTIVE rows are preserved as history and marked CANCELLED.
WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY "createdAt" DESC, "updatedAt" DESC, "id" DESC
    ) AS row_number
  FROM "UserVipSubscription"
  WHERE "status" = 'ACTIVE'
)
UPDATE "UserVipSubscription"
SET "status" = 'CANCELLED', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (
  SELECT "id" FROM ranked_active WHERE row_number > 1
);

-- A user may have at most one ACTIVE VIP subscription, even with distinct payments.
CREATE UNIQUE INDEX "UserVipSubscription_one_active_per_user"
ON "UserVipSubscription"("userId")
WHERE "status" = 'ACTIVE';
