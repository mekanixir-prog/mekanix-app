# MEKANIX — Roadmap to Release

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`  
**Status:** In Progress

## Current State

- 40 of 74 db consumer files migrated (186 of 322 calls)
- PR #3 open, main untouched
- All 4 CI workflows green on commit `06f161e`
- No remote D1 migration, no deploy

## Phases

### Phase 1: Complete Code Migration (In Progress)

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 1.1 | Migrate 9 remaining lib files (43 calls) | Pending | TypeScript + tests pass |
| 1.2 | Migrate 15 remaining route files (71 calls) | Pending | TypeScript + tests pass |
| 1.3 | Migrate admin-panel + admin routes (22 calls) | Pending | TypeScript + tests pass |
| 1.4 | Verify health/ready $queryRaw works on Workers | Pending | wrangler dev test passes |

### Phase 2: Security Review & Testing

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 2.1 | Security audit of all migrated endpoints | Pending | SECURITY_REVIEW.md all items resolved |
| 2.2 | Workers runtime tests (CRUD per domain) | Pending | All endpoints tested on wrangler dev |
| 2.3 | Concurrency/race condition tests | Pending | wallets, payments, prepay verified |
| 2.4 | Idempotency verification | Pending | Duplicate request handling confirmed |

### Phase 3: PR Review & Merge

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 3.1 | Update PR #3 description | Pending | Description matches actual code |
| 3.2 | Independent CI verification on final commit | Pending | All 4 workflows green on GitHub |
| 3.3 | Code review by project owner | Pending | Approval given |
| 3.4 | Merge PR #3 to main | Pending | main updated, CI green on main |

### Phase 4: Cloudflare Environment Setup

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 4.1 | Configure wrangler secrets (JWT_SECRET, etc.) | Pending | `wrangler secret list` confirms |
| 4.2 | Generate D1 migration SQL from schema | Pending | SQL file reviewed |
| 4.3 | Backup existing data (if any) | Pending | Backup verified |
| 4.4 | Apply migration to D1 (staging) | Pending | `wrangler d1 execute` success |
| 4.5 | Verify schema on D1 | Pending | Tables match schema.prisma |
| 4.6 | Seed test data | Pending | Test users/jobs created |

### Phase 5: Staging Deploy

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 5.1 | Build Worker (`bash scripts/build-cloudflare.sh`) | Pending | worker.js generated |
| 5.2 | Deploy to staging | Pending | `wrangler deploy` success |
| 5.3 | Smoke test staging endpoints | Pending | All critical paths pass |
| 5.4 | Test OTP flow on staging | Pending | Login works end-to-end |
| 5.5 | Test payment simulator on staging | Pending | Payment flow works |

### Phase 6: Production Readiness

| Step | Description | Status | Completion Criteria |
|---|---|---|---|
| 6.1 | Configure real SMS provider | Pending | SMS delivery confirmed |
| 6.2 | Configure real payment gateway | Pending | Zarinpal/IDPay integrated |
| 6.3 | Configure production domain | Pending | DNS + SSL configured |
| 6.4 | Apply migration to production D1 | Pending | Data integrity verified |
| 6.5 | Deploy to production | Pending | Worker live, health check 200 |
| 6.6 | Monitor for 24h | Pending | No critical errors |

## Dependencies

- Phase 2 depends on Phase 1
- Phase 3 depends on Phase 2
- Phase 4 depends on Phase 3
- Phase 5 depends on Phase 4
- Phase 6 depends on Phase 5

## Risks

- D1 has no `$transaction` — multi-step writes are not atomic
- Payment gateway is simulator-only — real integration not started
- 34 files still use sync `db` — Workers runtime will throw for those routes
- `admin-panel/` is a separate project — migration scope unclear
