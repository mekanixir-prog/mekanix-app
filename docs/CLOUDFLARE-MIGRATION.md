# MEKANIX — Cloudflare Free Migration Plan

## Why Cloudflare?
- **Zero cost** on Free plan (100K req/day Workers, 500MB D1, 10GB R2)
- No VPS needed — global CDN + HTTPS built-in
- D1 (SQLite) is compatible with existing Prisma schema

## Database ID
```
f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2
```

---

## Free Plan Limits (CORRECTED)

| Resource | Free Limit | Per-DB Limit | MEKANIX estimate |
|----------|-----------|-------------|-----------------|
| Workers requests | 100K/day | — | ~10K/day ✅ |
| Workers CPU | **10ms/invocation** | — | Must verify heavy endpoints |
| Workers memory | 128MB | — | ✅ |
| D1 storage | 5GB total | **500MB per DB** | ~100MB ✅ |
| D1 rows read | 5M/day | — | ~50K/day ✅ |
| D1 rows written | 100K/day | — | ~5K/day ✅ |
| R2 storage | 10GB | — | ~1GB ✅ |
| R2 Class A ops | 1M/month | — | ~10K/month ✅ |
| R2 Class B ops | 10M/month | — | ~100K/month ✅ |

**⚠️ Critical: Workers Free has 10ms CPU per invocation.** Heavy endpoints (dispatch
scoring, pricing engine, job status with transaction) must be profiled.

---

## Audit Results

### 1. `$transaction` — 13 usages (CRITICAL)

**D1 does NOT support Prisma `$transaction`.** BUT D1 has `batch()` which executes
statements sequentially and rolls back ALL if any fails — this is atomic enough.

**Migration: `$transaction(fn)` → `db.batch([...statements])`**

NOT compensating deletes (those can fail too and leave half-written state).

Files affected:
| File | What it does | Migration to batch() |
|------|-------------|---------------------|
| wallets/withdraw | Deduct wallet + create transaction | `batch([update wallet, create transaction])` |
| jobs/[id]/status | Job completion + wallet hold + notification + system message | `batch([updateMany job, updateMany wallet, create notification, create message])` |
| care/technician/missions/[id] | Status update + timeline event | `batch([updateMany booking, create timeline])` |
| care/bookings POST | Create booking + pricing snapshot | `batch([create booking, create snapshot])` |
| care/bookings/[id]/findings | Create finding + timeline | `batch([create finding, create timeline])` |
| care/bookings/[id]/extra-proposal | Create finding + approval + update booking + timeline + notification | `batch([create finding, create approval, updateMany booking, create timeline, create notification])` |
| care/bookings/[id]/approve-extra | Update approval + finding + booking + timeline | `batch([update approval, update finding, updateMany booking, create timeline])` |
| care/bookings/[id]/reject-extra | Same as approve but reject | `batch([update approval, update finding, updateMany booking, create timeline])` |
| care/bookings/[id]/inspection | Upsert inspection + timeline | `batch([upsert inspection, create timeline])` |
| care/bookings/[id]/health-report | Upsert report + update profile + timeline | `batch([upsert report, updateMany profile, create timeline])` |

**Strategy:** Use D1 `batch()` — atomic, no compensating deletes needed.

### 2. Redis — 33 references (CRITICAL)

**Cloudflare has no Redis.** Replace with D1 tables.

| Feature | Current | Cloudflare Replacement |
|---------|---------|----------------------|
| Rate limiting | Redis `INCR` (atomic) | D1 `batch([read count, write count])` — not perfectly atomic but acceptable for Free tier. For strict atomicity, use Durable Objects later. |
| Idempotency | Redis `GET/SET` | D1 table: `IdempotencyKey(key, response, expiresAt)` |
| Session cache | Redis `GET/SET` | D1 (already using DB for session — Redis was optional cache) |
| Health check | `isRedisAvailable()` | Remove — D1 health only |

**Note:** Rate limiting via D1 is NOT perfectly atomic (read-then-write race).
For production-grade rate limiting, migrate to Durable Objects with SQLite storage
(also available on Free plan). This is a Phase 2 improvement.

### 3. Node-only APIs — 3 files

| API | File | Replacement |
|-----|------|------------|
| `crypto.createHash("sha256")` | `src/lib/auth.ts`, `src/lib/otp-crypto.ts` | Web Crypto API: `crypto.subtle.digest("SHA-256", data)` |
| `fs` | `src/app/api/admin-panel/onboarding/route.ts` | Remove — store onboarding slides in D1 instead of filesystem |
| `child_process.exec` | `src/app/api/seed/route.ts` | Remove — seed via `wrangler d1 execute` |

### 4. Raw SQL — D1-compatible ✅
All 4 raw SQL queries use SQLite syntax. D1 IS SQLite — no changes needed.

### 5. Decimal.js — Workers-compatible ✅
`decimal.js` runs in Workers runtime. No change needed.

### 6. Cookies/Session ✅
`httpOnly`, `secure`, `sameSite` all supported in Workers.
`jose` library (JWT) is Workers-compatible.

### 7. Mini-services — 3 separate processes

| Service | Purpose | Cloudflare Replacement |
|---------|---------|----------------------|
| chat-service (port 3003) | WebSocket chat | Durable Objects (Phase 2) |
| telegram-rate-bot (3004) | Fetch USD→IRR rate | Cloudflare Cron Trigger |
| backup-scheduler (3005) | DB backup | Cron Trigger → R2 |

**Phase 1:** Defer chat-service (run externally if needed). Use Cron Triggers for bots.

### 8. PWA Service Worker — Fixed ✅
`/api/*` routes now use no-store (prevents data leakage).

---

## Migration Steps

### Step 01: OpenNext adapter
- Install `@opennextjs/cloudflare`
- Create `open-next.config.ts`
- Configure for Workers deployment

### Step 02: D1 + Prisma adapter
- Install `@prisma/adapter-d1`
- Keep `provider = "sqlite"` in schema (D1 IS SQLite)
- Create wrangler.toml with D1 binding
- Generate D1 migrations: `wrangler d1 migrations apply mekanix`

### Step 03: Replace 13 $transaction → D1 batch()
- Create `src/lib/db-batch.ts` helper
- Replace each `$transaction(async (tx) => { ... })` with `db.batch([...])`
- All operations atomic via D1 batch rollback

### Step 04: Remove Redis
- Create D1 tables: `RateLimit`, `IdempotencyKey`
- Update `src/lib/rate-limit.ts` to use D1
- Update `src/lib/auth.ts` `withIdempotency()` to use D1
- Remove `ioredis` dependency
- Remove `src/lib/redis.ts`

### Step 05: Fix Node APIs
- `crypto.createHash` → `crypto.subtle.digest` (Web Crypto)
- Remove `fs` from admin onboarding
- Remove `child_process` from seed route

### Step 06: R2 for file storage (Phase 2)
- Create R2 bucket: `wrangler r2 bucket create mekanix-uploads`
- Update upload routes to use R2

### Step 07: Cron Triggers (Phase 2)
- Telegram rate bot → Cron Trigger
- Backup scheduler → Cron Trigger + R2

### Step 08: Deploy
- `wrangler deploy`
- Test /api/health
- Test OTP flow (console mode)
- Run Playwright against Cloudflare URL
