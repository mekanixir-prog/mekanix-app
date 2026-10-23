-- MEKANIX — D1 migration: RateLimit + IdempotencyKey tables
-- Agent 1 (coordinator) fix for D1-01 (CRITICAL). Task ID: FIX-D1-01.
--
-- Context:
--   `prisma/schema.prisma` declares `RateLimit` (line ~1335) and
--   `IdempotencyKey` (line ~1346) models, but the initial D1 migration
--   `20260925000000_init` did NOT emit CREATE TABLE for them. The Prisma
--   client therefore emits SQL like `SELECT ... FROM "RateLimit"` against
--   a D1 database that has no such table.
--
--   Code paths in `src/lib/rate-limit.ts` and `src/lib/auth.ts` wrap these
--   calls in try/catch with a silent in-memory fallback. On Cloudflare
--   Workers production (multi-isolate), this silently degraded rate
--   limiting and idempotency to per-isolate in-memory state — effectively
--   bypassing OTP/payment/withdraw rate limits under any fan-out.
--
-- This migration is ADDITIVE (two new tables + indexes). It is safe to
-- apply to a populated D1 database; it does not alter existing rows.
--
-- Apply locally first:   bunx prisma migrate deploy
-- Apply to remote D1:    wrangler d1 migrations apply mekanix --remote
--   (remote application MUST be authorized by the repo owner and is
--    OUT OF SCOPE for this audit pass.)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex (unique key — one active counter per rate-limit key)
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex (composite: efficient purge of expired rows by key window)
CREATE INDEX "RateLimit_key_expiresAt_idx" ON "RateLimit"("key", "expiresAt");

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex (unique key — one cached response per idempotency key)
CREATE UNIQUE INDEX "IdempotencyKey_key_key" ON "IdempotencyKey"("key");

-- CreateIndex (composite: efficient purge of expired rows)
CREATE INDEX "IdempotencyKey_key_expiresAt_idx" ON "IdempotencyKey"("key", "expiresAt");
