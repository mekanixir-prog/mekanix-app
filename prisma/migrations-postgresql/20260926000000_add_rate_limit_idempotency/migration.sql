-- MEKANIX — PostgreSQL migration: RateLimit + IdempotencyKey tables
-- PostgreSQL equivalent of the SQLite D1 migration 20260926000000_add_rate_limit_idempotency.
--
-- This migration is the additive companion to 20260925000000_init — it adds
-- two tables that were declared in schema.prisma but missing from the init
-- migration's CREATE TABLE output.
--
-- This migration is ADDITIVE (two new tables + indexes). It is safe to
-- apply to a populated PostgreSQL database; it does not alter existing rows.

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique key — one active counter per rate-limit key)
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex (composite: efficient purge of expired rows by key window)
CREATE INDEX "RateLimit_key_expiresAt_idx" ON "RateLimit"("key", "expiresAt");

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique key — one cached response per idempotency key)
CREATE UNIQUE INDEX "IdempotencyKey_key_key" ON "IdempotencyKey"("key");

-- CreateIndex (composite: efficient purge of expired rows)
CREATE INDEX "IdempotencyKey_key_expiresAt_idx" ON "IdempotencyKey"("key", "expiresAt");
