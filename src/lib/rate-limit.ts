// MEKANIX — Rate Limiting (shared D1 store; dev-only in-memory fallback)
//
// On Cloudflare Workers: uses the D1 `RateLimit` table (distributed across all
// isolates that share the D1 database).
// Outside production without D1: falls back to in-memory (single-instance). Production fails closed.
//
// The synchronous `rateLimit()` function is kept for backward compat with
// callers that don't want to await — it uses the in-memory store only.
//
// MIGRATION: Uses `getDbForLib()` instead of direct `db` import.
// This works in both dev (Node.js + SQLite) and Workers (D1 via PrismaD1).

import { getDbForLib } from "./db-access";
import { Prisma } from "@prisma/client";

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

  // Cloudflare overwrites CF-Connecting-IP with the actual visitor address.
  // Never prefer the first X-Forwarded-For entry: clients can supply a forged
  // prefix and proxies append their observed address later in the chain.
  const cloudflareIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp;

  // For non-Cloudflare reverse proxies, the right-most entry is the closest
  // trusted hop (and is the value appended by the proxy).
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const rightMost = forwarded.split(",").map((value) => value.trim()).filter(Boolean).at(-1);
    if (rightMost) return rightMost;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
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

// Async version that uses D1 `RateLimit` table.
// In-memory fallback is development-only. Production returns an explicit unavailable result; every route caller must map it to HTTP 503.
//
// The D1 table stores: { key, count, expiresAt }.
// Each request increments count; if count > max → deny.
// On window expiry, the row is reset (upsert with count=1).

export type RateLimitResult = { success: boolean; resetMs: number; unavailable?: boolean };

export async function rateLimitAsync(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const d1Key = `rl:${key}`;
  const now = Date.now();
  const limit = Math.max(1, Math.trunc(max));
  const safeWindowMs = Math.max(1, Math.trunc(windowMs));
  const nowDate = new Date(now);
  const expiresAt = new Date(now + safeWindowMs);

  try {
    const db = await getDbForLib();

    // One database statement owns initialization, expiry reset, increment and
    // deny-state saturation. Concurrent first hits/expiry-boundary requests
    // cannot reset the counter independently.
    const rows = await db.$queryRaw<Array<{ count: number; expiresAt: Date | string }>>(Prisma.sql`
      INSERT INTO "RateLimit" ("id", "key", "count", "expiresAt")
      VALUES (${crypto.randomUUID()}, ${d1Key}, 1, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimit"."expiresAt" <= ${nowDate} THEN 1
          WHEN "RateLimit"."count" < ${limit + 1} THEN "RateLimit"."count" + 1
          ELSE "RateLimit"."count"
        END,
        "expiresAt" = CASE
          WHEN "RateLimit"."expiresAt" <= ${nowDate} THEN excluded."expiresAt"
          ELSE "RateLimit"."expiresAt"
        END
      RETURNING "count", "expiresAt"
    `);

    if (rows.length !== 1) throw new Error("Rate-limit upsert did not return exactly one row");
    const entry = rows[0];
    const count = Number(entry.count);
    const resetAt = entry.expiresAt instanceof Date
      ? entry.expiresAt.getTime()
      : new Date(entry.expiresAt).getTime();

    if (!Number.isFinite(count) || !Number.isFinite(resetAt)) {
      throw new Error("Rate-limit store returned an invalid row");
    }

    return {
      success: count <= limit,
      resetMs: Math.max(0, resetAt - now),
    };
  } catch {
    // A per-isolate Map is not a security control in multi-isolate production.
    // Deny the request instead of silently weakening OTP/payment/withdraw limits.
    if (process.env.NODE_ENV === "production") {
      return { success: false, resetMs: safeWindowMs, unavailable: true };
    }
    // Local development only: keep the single-process fallback.
    return memRateLimit(key, limit, safeWindowMs);
  }
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore.entries()) {
    if (entry.resetAt < now) memStore.delete(key);
  }
}, 5 * 60 * 1000);
