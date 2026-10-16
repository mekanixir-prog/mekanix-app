# MEKANIX — Release Checklist

**Last Updated:** 2026-10-16
**Commit:** `e916b3e` (feature/cloudflare-d1-validation, PUSHED to GitHub)
**Baseline:** main @ `e4c2faf` (untouched)

> ✅ This checklist reflects the state on commit `e916b3e`, which has been pushed to GitHub.
> CI has run on this commit — all 4 workflows are green (verified via GitHub API).
> The official remote `feature/cloudflare-d1-validation` is now on `e916b3e`.

## Status Legend

- ☐ Not started
- ☑ Completed (verified locally)
- ⚠ Blocked / pending dependency

---

## Phase 1: Code Migration

- ☑ Migrate auth (4 routes + 2 lib files, 38 calls) — verified: `auth.ts` uses `getDbForLib` (14 refs)
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
- ☑ Migrate remaining 9 lib files (43 calls) — verified: 12 lib files use `getDbForLib`
- ☑ Migrate remaining 15 route files (71 calls) — verified: 65 API files use `getDbForLib`, 0 use sync `db`
- ☑ Migrate admin-panel + admin routes (22 calls) — verified: 6 admin files use `getDbForLib`

## Phase 2: Quality & Security

- ☑ TypeScript passes (`bunx tsc --noEmit` exit 0) — verified on `e916b3e` (CI green)
- ☑ ESLint passes (0 errors, 2 warnings) — verified on `e916b3e` (CI green)
- ☑ Tests pass (389/389) — verified on `e916b3e` (CI green) (was 335/335 on `7109d65`)
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
- ☑ Security audit of remaining 34 files — completed (Phase 3 audit V2: 20 findings)
- ☑ SEC-7 fix: VIP subscribe production guard + payment validation
- ☑ SEC-8 fix: Wallets auto-release conditional updateMany + count check
- ☑ SEC-9 fix: Withdraw atomic decrement + reorder (orphan prevention)
- ☑ SEC-10 fix: OTP atomic updateMany (consumed:false WHERE)
- ☑ SEC-11 fix: Timeline BOLA (requireBookingParticipant)
- ☑ SEC-4 fix: Admin PATCH audit logging (5 branches)
- ☑ SEC-5 fix: Admin login rate limit + audit logging
- ☑ SEC-13 fix: Unified 401 + timing mitigation (DUMMY_HASH)
- ☐ Workers runtime test for all migrated endpoints — NOT done (D1 staging required)
- ☐ Concurrency/race condition verification on Workers — NOT done (D1 staging required)

## Phase 3: CI & PR

- ☑ CI green on commit `06f161e` (verified by reviewer, historical)
- ☑ CI green on commit `0942466` (remote feature HEAD, 4 workflows success)
- ☑ CI green on commit `e916b3e` (PUSHED, 4/4 workflows success — verified via GitHub API)
- ☑ PR #3 description updated (Phase 3 audit)
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

## Phase 7: Backup & Restore Testing

- ☐ Test backup script: `bash scripts/backup-db.sh`
- ☐ Test restore script: `bash scripts/restore-db.sh`
- ☐ Verify backup integrity (checksum + row count)
- ☐ Verify restore produces identical data
- ☐ Document backup schedule + retention policy

## Rollback Plan

- [ ] Previous `wrangler.toml` + `next.config.ts` backed up
- [ ] D1 backup SQL available
- [ ] `git revert` to `e4c2faf` (main before merge) documented
- [ ] `wrangler rollback` command documented (if available)
- [ ] DNS rollback plan documented (if domain changed)

---

## Discrepancy Resolution

### Previous checklist (on `0942466`) vs current state (on `e916b3e`):

| Item | Previous (`0942466`) | Current (`e916b3e`) | Evidence |
|------|---------------------|---------------------|----------|
| Lib migration (9 files) | ☐ Not started | ☑ Completed | 12 lib files use `getDbForLib` |
| Route migration (15 files) | ☐ Not started | ☑ Completed | 65 API files use `getDbForLib`, 0 use sync `db` |
| Admin migration (22 calls) | ☐ Not started | ☑ Completed | 6 admin files use `getDbForLib` |
| Test count | 335/335 | 389/389 | +54 tests (SEC-4/5/7/8/10/11/13 + B2.2) |
| Security audit (34 files) | ☐ Not started | ☑ Completed | Phase 3 audit V2: 20 findings |
| Workers runtime test | ☐ Not started | ☐ Not done | Requires D1 staging |
| Concurrency on Workers | ☐ Not started | ☐ Not done | Requires D1 staging |

### Blocking items for Release Candidate:

1. ☑ Commit `e916b3e` pushed to GitHub — CI green (4/4 workflows)
2. ☐ Workers runtime test (requires D1 staging)
3. ☐ Concurrency verification on Workers (requires D1 staging)
4. ☐ Backup/restore testing (requires staging environment)

