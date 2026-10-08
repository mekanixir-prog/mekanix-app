// MEKANIX — Rate Limiting (D1-backed with in-memory fallback)
//
// On Cloudflare Workers: uses the D1 `RateLimit` table (distributed across all
// isolates that share the D1 database).
// In local development without D1: falls back to in-memory (single-instance).
//
// The synchronous `rateLimit()` function is kept for backward compat with
// callers that don't want to await — it uses the in-memory store only.

import { db } from "./db";

// ──────────── Rate limit configuration ────────────

export const RATE_LIMITS = {
  OTP_SEND: { max: 5, windowMs: 10 * 60_000 },   // 5 per 10 minutes
  OTP_VERIFY: { max: 5, windowMs: 60_000 },       // 5 per minute
  PAYMENT: { max: 5, windowMs: 60_000 },           // 5 per minute
  WITHDRAW: { max: 3, windowMs: 3_600_000 },       // 3 per hour
  API_DEFAULT: { max: 60, windowMs: 60_000 },      // 60 per minute
} as const;

// ──────────── Client ID extraction ────────────

export function getClientId(req: Request, userId?: string): string {
  if (userId) return userId;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "anonymous";
}

// ──────────── In-memory store (fast path) ────────────
// Used when D1 is not available (dev mode without DB) — single-instance only.

const memStore = new Map<string, { count: number; resetAt: number }>();

function memRateLimit(key: string, max: number, windowMs: number): { success: boolean; resetMs: number } {
  const now = Date.now();
  const entry = memStore.get(key);

  if (!entry || entry.resetAt < now) {
    memStore.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, resetMs: windowMs };
  }

  if (entry.count >= max) {
    return { success: false, resetMs: entry.resetAt - now };
  }

  entry.count++;
  return { success: true, resetMs: entry.resetAt - now };
}

// ──────────── Unified rate limit function ────────────
// Synchronous version (uses in-memory) — for backward compat.
// Existing callers use rateLimit(key, max, windowMs) synchronously.

export function rateLimit(key: string, max: number, windowMs: number): { success: boolean; resetMs: number } {
  return memRateLimit(key, max, windowMs);
}

// Async version that uses D1 `RateLimit` table when available.
// Falls back to in-memory on any error (dev mode without DB).
//
// The D1 table stores: { key, count, expiresAt }.
// Each request increments count; if count > max → deny.
// On window expiry, the row is reset (upsert with count=1).

export async function rateLimitAsync(key: string, max: number, windowMs: number): Promise<{ success: boolean; resetMs: number }> {
  const d1Key = `rl:${key}`;
  const now = Date.now();

  // Try D1 RateLimit table (works on Cloudflare + local SQLite via Prisma)
  try {
    const existing = await db.rateLimit.findUnique({ where: { key: d1Key } });

    if (!existing || existing.expiresAt.getTime() < now) {
      // Window expired (or first ever request) — start a fresh window.
      await db.rateLimit.upsert({
        where: { key: d1Key },
        create: { key: d1Key, count: 1, expiresAt: new Date(now + windowMs) },
        update: { count: 1, expiresAt: new Date(now + windowMs) },
      });
      return { success: true, resetMs: windowMs };
    }

    if (existing.count >= max) {
      return { success: false, resetMs: existing.expiresAt.getTime() - now };
    }

    await db.rateLimit.update({
      where: { key: d1Key },
      data: { count: { increment: 1 } },
    });
    return { success: true, resetMs: existing.expiresAt.getTime() - now };
  } catch {
    // Fall back to in-memory (dev mode without DB)
    return memRateLimit(key, max, windowMs);
  }
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore.entries()) {
    if (entry.resetAt < now) memStore.delete(key);
  }
}, 5 * 60 * 1000);
