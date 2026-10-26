-- MEKANIX — SQLite/D1 migration: VIP payment idempotency and active-subscription guard.
-- Preserve existing subscription history: this migration intentionally does NOT
-- delete or rewrite duplicate rows. Run the duplicate preflight queries below
-- against a backup first. If duplicates exist, reconcile them explicitly before
-- applying this migration; the unique-index creation must fail rather than silently
-- deleting financial/subscription records.
--
-- Preflight:
-- SELECT "paymentId", COUNT(*) FROM "UserVipSubscription"
-- WHERE "paymentId" IS NOT NULL GROUP BY "paymentId" HAVING COUNT(*) > 1;
-- SELECT "userId", COUNT(*) FROM "UserVipSubscription"
-- WHERE "status" = 'ACTIVE' GROUP BY "userId" HAVING COUNT(*) > 1;

-- A payment may back only one subscription, regardless of subscription status.
CREATE UNIQUE INDEX "UserVipSubscription_paymentId_key"
ON "UserVipSubscription"("paymentId");

-- Enforce at most one ACTIVE subscription per user. Prisma schema cannot express
-- this partial index, so keep it as an explicit provider-specific migration.
CREATE UNIQUE INDEX "UserVipSubscription_one_active_per_user_key"
ON "UserVipSubscription"("userId")
WHERE "status" = 'ACTIVE';
