// MEKANIX — Redis adapter (in-memory stub — Cloudflare D1 migration)
//
// Previously this module bridged to a real Redis via `ioredis` when REDIS_URL
// was set, with an in-memory fallback. As of the Cloudflare migration, the
// app uses D1 tables (`RateLimit`, `IdempotencyKey`) for distributed state
// that previously lived in Redis — see `src/lib/rate-limit.ts` and
// `src/lib/auth.ts#withIdempotency`.
//
// This module is retained as an in-memory-only stub so existing imports
// (`isRedisAvailable` from /api/health, the test mocks for kvGet/kvSet/kvDel/
// kvIncr) keep resolving. It no longer pulls in `ioredis`, so the dependency
// could be dropped from package.json.
//
// All operations hit a process-local Map. On Cloudflare Workers each isolate
// has its own Map (effectively per-request) — but the only live caller is
// /api/health, which just reports `isRedisAvailable() → false`.

// ──────────── In-memory store ────────────
const memStore = new Map<string, { value: string; expiresAt: number }>();

function memGet(key: string): string | null {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlMs: number): void {
  memStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function memDel(key: string): void {
  memStore.delete(key);
}

function memIncr(key: string, ttlMs: number): number {
  const current = parseInt(memGet(key) ?? "0", 10);
  const next = current + 1;
  memSet(key, String(next), ttlMs);
  return next;
}

// ──────────── Unified key-value interface ────────────
// All operations hit the in-memory Map. There is no Redis connection anymore.

export async function kvGet(key: string): Promise<string | null> {
  return memGet(key);
}

export async function kvSet(key: string, value: string, ttlMs: number): Promise<void> {
  memSet(key, value, ttlMs);
}

export async function kvDel(key: string): Promise<void> {
  memDel(key);
}

export async function kvIncr(key: string, ttlMs: number): Promise<number> {
  return memIncr(key, ttlMs);
}

// Redis is no longer wired up — always returns false so /api/health reports
// the in-memory fallback state honestly.
export async function isRedisAvailable(): Promise<boolean> {
  return false;
}

// Clean up in-memory store periodically (every 5 min) — same as the old impl.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore.entries()) {
    if (entry.expiresAt < now) memStore.delete(key);
  }
}, 5 * 60 * 1000);
