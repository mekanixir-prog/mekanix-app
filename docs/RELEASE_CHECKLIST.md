# MEKANIX — Release Checklist

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`

## Status Legend

- ☐ Not started
- ☑ Completed
- ⚠ Blocked / pending dependency

---

## Phase 1: Code Migration

- ☑ Migrate auth (4 routes + 2 lib files, 38 calls)
- ☑ Migrate vehicles (2 routes, 5 calls)
- ☑ Migrate technicians (2 routes, 2 calls)
- ☑ Migrate service-requests + jobs (7 routes, 34 calls)
- ☑ Migrate dashboard (1 route, 16 calls)
- ☑ Migrate gateway (2 routes, 5 calls) + security hardening
- ☑ Migrate prepay (1 route, 10 calls) + security hardening
- ☑ Migrate invoices (2 routes, 13 calls)
- ☑ Migrate payments (1 route, 12 calls) + race condition fix
- ☑ Migrate wallets (2 routes, 11 calls) + atomic balance
- ☑ Migrate care (16 routes, 58 calls)
- ☐ Migrate remaining 9 lib files (43 calls)
- ☐ Migrate remaining 15 route files (71 calls)
- ☐ Migrate admin-panel + admin routes (22 calls)

## Phase 2: Quality & Security

- ☑ TypeScript passes (`bunx tsc --noEmit` exit 0)
- ☑ ESLint passes (0 errors, 2 warnings)
- ☑ Tests pass (335/335)
- ☑ `verifySession()` fail-closed in production
- ☑ `createSession()` fail-closed in production
- ☑ `revokeSession()` / `revokeAllUserSessions()` no error swallowing
- ☑ `JWT_SECRET` in `.dev.vars` (not `wrangler.toml [vars]`)
- ☑ Gateway production guard (404)
- ☑ Prepay auth + ownership + optimistic concurrency
- ☑ Payments duplicate guard (409) + optimistic concurrency
- ☑ Wallets atomic balance deduction
- ☑ Test routes removed (`/api/test/d1`, `/api/test/cache`)
- ☑ `runSequential` unused imports removed
- ☐ Security audit of remaining 34 files
- ☐ Workers runtime test for all migrated endpoints
- ☐ Concurrency/race condition verification on Workers

## Phase 3: CI & PR

- ☑ CI green on commit `06f161e` (verified by reviewer)
- ☐ CI green on final commit (after remaining migration)
- ☑ PR #3 description updated
- ☐ Independent code review by project owner
- ☐ Merge PR #3 to main
- ☐ CI green on main after merge

## Phase 4: Cloudflare Environment

- ☐ `wrangler secret put JWT_SECRET` (production)
- ☐ `wrangler secret put DATABASE_URL` (if needed)
- ☐ Configure SMS provider (Kavenegar/MeliPayamak/FaraPayamak)
- ☐ Configure payment gateway (Zarinpal/IDPay)
- ☐ Configure production domain + DNS
- ☐ Configure `wrangler.toml` for production (NODE_ENV=production)

## Phase 5: D1 Migration

- ☐ Generate migration SQL: `bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
- ☐ Review SQL for D1 compatibility
- ☐ Backup existing data (if any)
- ☐ Apply to staging D1: `wrangler d1 execute mekanix --remote --file=migration.sql`
- ☐ Verify tables: `wrangler d1 execute mekanix --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
- ☐ Seed test data
- ☐ Apply to production D1 (with backup + rollback plan)

## Phase 6: Deploy & Verify

- ☐ Build Worker: `bash scripts/build-cloudflare.sh`
- ☐ Deploy to staging: `wrangler deploy --env staging` (or preview)
- ☐ Smoke test staging endpoints
- ☐ Test OTP flow end-to-end
- ☐ Test payment simulator
- ☐ Test CRUD operations (vehicles, jobs, invoices)
- ☐ Deploy to production: `wrangler deploy`
- ☐ Verify `/api/health` returns 200
- ☐ Verify `/api/ready` returns 200
- ☐ Monitor logs for 24h
- ☐ Confirm no critical errors

## Rollback Plan

- [ ] Previous `wrangler.toml` + `next.config.ts` backed up
- [ ] D1 backup SQL available
- [ ] `git revert` to `e4c2faf` (main before merge) documented
- [ ] `wrangler rollback` command documented (if available)
- [ ] DNS rollback plan documented (if domain changed)
