// MEKANIX — Redis adapter with in-memory fallback
// 
// When REDIS_URL is set, uses Redis for distributed state.
// Otherwise, falls back to in-memory (single-instance dev mode).
//
// Used by: rate-limit.ts, auth.ts (idempotency), sync-engine.ts

import type { LRUCache } from "lru-cache";

// ──────────── In-memory store (fallback) ────────────
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

// ──────────── Redis client (lazy-loaded) ────────────
let redisClient: any = null;
let redisAvailable = false;

async function getRedisClient(): Promise<any | null> {
  if (redisClient !== null) return redisClient;
  
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    redisAvailable = false;
    return null;
  }

  try {
    // Dynamic import so the dependency is optional
    const { Redis } = await import("ioredis");
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    
    // Test connection
    await redisClient.ping();
    redisAvailable = true;
    console.log("✅ Redis connected for distributed state");
    return redisClient;
  } catch (e) {
    console.warn("⚠️  Redis unavailable, falling back to in-memory:", (e as Error).message);
    redisAvailable = false;
    return null;
  }
}

// ──────────── Unified key-value interface ────────────
// Works with Redis (distributed) or in-memory (single instance).

export async function kvGet(key: string): Promise<string | null> {
  const client = await getRedisClient();
  if (client) {
    try {
      return await client.get(key);
    } catch {
      return memGet(key);
    }
  }
  return memGet(key);
}

export async function kvSet(key: string, value: string, ttlMs: number): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    try {
      await client.set(key, value, "PX", ttlMs);
      return;
    } catch {
      // fall through to in-memory
    }
  }
  memSet(key, value, ttlMs);
}

export async function kvDel(key: string): Promise<void> {
  const client = await getRedisClient();
  if (client) {
    try {
      await client.del(key);
      return;
    } catch {
      // fall through
    }
  }
  memDel(key);
}

export async function kvIncr(key: string, ttlMs: number): Promise<number> {
  const client = await getRedisClient();
  if (client) {
    try {
      const multi = client.multi();
      multi.incr(key);
      multi.pexpire(key, ttlMs);
      const results = await multi.exec();
      return results[0][1] as number;
    } catch {
      return memIncr(key, ttlMs);
    }
  }
  return memIncr(key, ttlMs);
}

// Check if Redis is available (for health checks)
export async function isRedisAvailable(): Promise<boolean> {
  const client = await getRedisClient();
  return client !== null && redisAvailable;
}

// Clean up in-memory store periodically (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memStore.entries()) {
    if (entry.expiresAt < now) memStore.delete(key);
  }
}, 5 * 60 * 1000);
