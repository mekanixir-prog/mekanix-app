# MEKANIX — Cloudflare Free Migration Plan

## Why Cloudflare?
- Zero cost on Free plan (100K req/day Workers, 5GB D1, 10GB R2)
- No VPS needed — global CDN + HTTPS built-in
- D1 (SQLite) is compatible with existing Prisma schema

## Audit Results

### 1. $transaction — 13 usages (CRITICAL)
D1 does NOT support transactions. Must refactor to sequential operations.

Files affected:
- wallets/withdraw, jobs/[id]/status, care/technician/missions/[id]
- care/bookings (POST), findings, extra-proposal, approve-extra, reject-extra
- inspection, health-report

Strategy: Replace $transaction with sequential writes + compensating deletes on failure.

### 2. Redis — 33 references (CRITICAL)
Cloudflare has no Redis. Replace with D1 tables.

| Feature | Replacement |
|---------|------------|
| Rate limiting | D1 table: RateLimit(key, count, expiresAt) |
| Idempotency | D1 table: IdempotencyKey(key, response, expiresAt) |
| Health check | Remove Redis check, use D1 only |

### 3. Node-only APIs — 3 files
| API | File | Replacement |
|-----|------|------------|
| crypto.createHash | auth.ts, otp-crypto.ts | Web Crypto API |
| fs | admin-panel onboarding | Remove (use D1) |
| child_process | seed route | Remove |

### 4. Raw SQL — D1-compatible
All raw SQL uses SQLite syntax — works on D1.

### 5. Decimal.js — Works in Workers
No change needed.

### 6. Mini-services — 3 processes
| Service | Cloudflare Replacement |
|---------|----------------------|
| chat-service | Durable Objects (deferred) |
| telegram-rate-bot | Cron Trigger |
| backup-scheduler | Cron Trigger + R2 |

### 7. PWA sw.js — Fixed
/api/* routes now use no-store (prevents data leakage).

## Free Plan Limits
| Resource | Free Limit | MEKANIX estimate |
|----------|-----------|-----------------|
| Workers requests | 100K/day | ~10K/day OK |
| D1 rows read | 5M/day | ~50K/day OK |
| D1 rows written | 100K/day | ~5K/day OK |
| D1 storage | 5GB | ~100MB OK |
| R2 storage | 10GB | ~1GB OK |

## Migration Steps
1. Create cloudflare-migration branch
2. Install @prisma/adapter-d1
3. Create D1 database (wrangler d1 create mekanix)
4. Replace $transaction with sequential writes (13 files)
5. Create RateLimit + IdempotencyKey D1 tables
6. Replace crypto.createHash with Web Crypto
7. Remove fs, child_process, ioredis
8. Create wrangler.toml
9. Deploy with wrangler
10. Test staging
