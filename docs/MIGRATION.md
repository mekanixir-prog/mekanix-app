# MEKANIX — Production Migration Guide

This document covers the remaining architectural items for production deployment.

---

## 1. Database: SQLite (dev) → PostgreSQL (production)

### Current State
- **Dev**: `prisma/schema.prisma` uses `provider = "sqlite"`
- **Dev migrations**: `prisma/migrations/` (SQLite DDL)
- **Production migrations**: `prisma/migrations-postgresql/` (PostgreSQL DDL)
- **CI**: Tests against BOTH SQLite (ci.yml) AND PostgreSQL (postgresql-ci.yml)

### Switch to PostgreSQL
```bash
# 1. Switch the schema provider
bash scripts/db-switch-provider.sh postgresql

# 2. Set the database URL
export DATABASE_URL=postgresql://user:pass@host:5432/mekanix

# 3. Copy PostgreSQL migrations to the active directory
cp prisma/migrations-postgresql/migration_lock.toml prisma/migrations/migration_lock.toml
cp prisma/migrations-postgresql/20260925000000_init/migration.sql prisma/migrations/20260925000000_init/migration.sql

# 4. Deploy migrations
bun run db:migrate   # prisma migrate deploy

# 5. Generate Prisma Client
bun run db:generate
```

### Switch back to SQLite (dev)
```bash
bash scripts/db-switch-provider.sh sqlite
bun run db:migrate:dev
```

### CI Verification
- **SQLite CI** (`.github/workflows/ci.yml`): tests against SQLite
- **PostgreSQL CI** (`.github/workflows/postgresql-ci.yml`): tests against real PostgreSQL 16 service container
- Both must pass before merge to main

---

## 2. Redis for Distributed State

### Current State
- `src/lib/redis.ts` adapter with `kvGet/kvSet/kvDel/kvIncr`
- Rate limiting: `rateLimitAsync()` uses Redis when `REDIS_URL` is set
- Idempotency: `withIdempotency()` uses Redis when `REDIS_URL` is set
- Fallback: in-memory when `REDIS_URL` is not set

### Production Setup
```bash
export REDIS_URL=redis://your-redis-host:6379
```

No code changes needed — the adapter auto-detects Redis availability.

---

## 3. Real ETA Provider

### Current State
- `src/lib/eta-provider.ts` supports Neshan, Google Maps, OSRM
- Default: 40 km/h haversine estimate

### Production Setup
```bash
# Option A: Neshan (Iranian routing API)
export NESHAN_API_KEY=your_key

# Option B: Google Maps
export GOOGLE_MAPS_API_KEY=your_key

# Option C: OSRM (self-hosted)
export OSRM_API_URL=https://your-osrm-server.com
```

---

## 4. SMS Provider (OTP)

### Current State
- OTP generation: CSPRNG (`crypto.randomInt`)
- OTP storage: SHA-256 hashed (not plaintext)
- OTP delivery: TODO — no SMS provider integrated yet

### Production Setup
Integrate an Iranian SMS provider in `src/app/api/auth/otp/send/route.ts`:
```typescript
// Kavenegar
await fetch(`https://api.kavenegar.com/v1/${API_KEY}/verify/lookup.json?receptor=${phone}&token=${code}&template=mekanix-otp`);

// MeliPayamak
await fetch(`https://rest.payamak-panel.com/api/SendSMS/SendSMS`, { ... });
```

---

## 5. Service Write-Side Unification

### Current State
- Read facade: `src/lib/service-unified.ts` (GET /api/services)
- Write facade: `src/lib/service-write.ts` (createService, transitionServiceStatus)
- Legacy routes still exist but the facade is the recommended path

### Future: Deprecate Legacy Routes
1. Update `/api/service-requests` to call `createService()`
2. Update `/api/jobs/[id]/status` to call `transitionServiceStatus()`
3. Update `/api/care/bookings` to call `createService()`
4. Remove direct DB writes from individual routes
