# MEKANIX — Post-PR #3 Release Readiness Audit

**Audit date:** 2026-10-31  
**Repository:** `mekanixir-prog/mekanix-app`  
**Audited branch:** `main`  
**Audited commit:** `efeed90291c6346e23900f7416561e49dfe1d08c`  
**PR #3:** [Merged 2026-10-26](https://github.com/mekanixir-prog/mekanix-app/pull/3)  
**Decision:** **NOT READY FOR PUBLIC RELEASE.** Continue code hardening and preview verification. Do not activate real payment/SMS or mutate production data as part of this audit.

> This audit supersedes contradictory historical status statements in older documents. It is a source review of the merged GitHub tree and recorded Actions runs, not evidence of a live Cloudflare deployment, remote D1 migration, production credentials, or real-provider verification.

## 1. Verified GitHub state

- Default branch: `main`.
- PR #3 is **closed and merged**, merge commit `efeed90291c6346e23900f7416561e49dfe1d08c`.
- The PR head was `8a4eef90d8842e6a5070ac74d85321b43c3268d1`.
- Five GitHub Actions workflows completed successfully for that PR head:
  - CI — run 40345633616
  - PostgreSQL CI — run 40345633319
  - Production readiness — run 40345633288
  - Cloudflare Build — run 40345633371
  - Docker E2E — run 40345633290
- These were PR-triggered checks. They do not prove a deployment or remote D1 runtime behavior.

## 2. Confirmed changes present on merged main

The merged commit message and current source/migration files confirm these changes are present:

| Area | Current evidence |
|---|---|
| D1 rate-limit/idempotency schema | SQLite/D1 migration `20260926000000_add_rate_limit_idempotency` creates both tables and indexes |
| PostgreSQL parity | Matching PostgreSQL migration exists |
| Iranian phone lookup | OTP verification uses bounded `findUnique` variants instead of an unbounded full-user scan |
| VIP payment reuse | `UserVipSubscription.paymentId` is unique in Prisma schema and both provider migrations |
| One active VIP per user | Provider-specific partial unique indexes exist in D1 and PostgreSQL migrations |
| Technician PII | Public technician list selects a safe user field allowlist and omits phone |
| Admin token validation | Admin JWT payload requires a non-empty `adminId` and ADMIN/SUPER_ADMIN role |
| Destructive DB shortcut | Current `package.json` scripts no longer include `--accept-data-loss` |

## 3. New findings requiring engineering work

These findings were checked against the merged `main` source, not copied from the older audit snapshot.

### HIGH — SEC/OPS: rate limiting silently falls back to isolate-local memory

File: `src/lib/rate-limit.ts`

`rateLimitAsync()` catches all database errors and calls `memRateLimit()`. That fallback is acceptable for local development, but in Cloudflare Workers it is not a shared cross-isolate limit. If D1 becomes unavailable or a schema/runtime regression occurs, production OTP/payment/withdrawal limits can silently weaken.

**Required:** fail closed in production with an explicit service-unavailable result; retain in-memory fallback only outside production. Add tests for database allow/deny, database outage in production, and development fallback.

### HIGH — SEC: idempotency silently falls back to isolate-local memory

File: `src/lib/auth.ts`, function `withIdempotency()`

The helper catches database errors and executes the callback using an isolate-local cache. Before changing behavior, enumerate every call site and confirm the expected error handling. In production, a failed shared idempotency store must not silently permit re-execution of a state-changing operation.

**Required:** typed failure/503 in production, development-only fallback, and replay/concurrency/expiry/outage tests.

### HIGH — FINANCIAL INTEGRITY: wallet auto-release is a split write

File: `src/app/api/wallets/route.ts`

The handler first conditionally changes a transaction from PENDING to AVAILABLE, then performs a separate wallet balance update. If the second write fails after the first succeeds, the transaction is no longer eligible for retry while the wallet balance delta was not applied. Reversing the order would create a double-credit window.

**Required:** design a D1-safe exactly-once and retryable release protocol (for example, a reviewed transactional D1 batch or a durable unique release ledger with atomic application semantics). Add injected-failure and concurrent-release tests. Do not patch by merely reversing the two writes.

### MEDIUM — PRODUCTION CONFIGURATION: admin signing secret fallback

File: `src/lib/admin-auth.ts`

If `ADMIN_JWT_SECRET` is absent, production currently falls back to `JWT_SECRET` and logs a warning. Payload-shape validation is an additional defense, but the production configuration should require a dedicated admin secret.

**Required:** add a production readiness gate for `ADMIN_JWT_SECRET`; retain any desired development fallback only in non-production. Add configuration tests.

Tracking issue: [#22 — Post-PR #3 hardening](https://github.com/mekanixir-prog/mekanix-app/issues/22).

## 4. External integrations intentionally deferred

These are not reasons to stop local code development, but they must be completed and verified before public launch:

- Real SMS provider credentials and end-to-end OTP delivery.
- Real payment provider wiring, sandbox certification, callback authenticity/signature verification, amount/currency validation, replay prevention, reconciliation, and live credentials.
- Production domain, DNS, TLS, cookies, and redirects.
- Production Cloudflare Worker and D1 configuration, separate from preview.
- Monitoring, alerting, backup/restore and rollback drills.

Important: the presence of `PAYMENT_PROVIDER=simulator` in configuration does not by itself prove the provider abstraction is wired into the payment routes. Do not enable real-money flows by changing an environment variable alone. Tracking issue: [#24 — Payment gateway integration](https://github.com/mekanixir-prog/mekanix-app/issues/24).

## 5. Ordered execution plan

### Gate A — close merged-code risks (now; no paid production services needed)

- [ ] Fix production fail-open behavior in `rateLimitAsync()`.
- [ ] Audit every `withIdempotency()` caller and remove production memory fallback.
- [ ] Implement exactly-once wallet auto-release with D1-safe recovery.
- [ ] Require dedicated `ADMIN_JWT_SECRET` in production readiness.
- [ ] Add regression, concurrency, and injected-failure tests.
- [ ] Re-run all CI workflows on the exact new PR head.

### Gate B — complete non-production preview validation

- [ ] Use a separate preview Worker and D1 database.
- [ ] Back up/export preview data before migration; run provider-specific migration preflight.
- [ ] Apply migrations to preview only and verify schema/indexes.
- [ ] Test OTP, customer asset registration, service request, technician dispatch/status, admin authorization, notifications, wallet/VIP simulator flows, and support.
- [ ] Test DB/SMS/payment-provider timeouts, expired OTP, duplicate callbacks, unauthorized object IDs, and concurrent requests.
- [ ] Perform and record backup/restore and rollback rehearsals.

### Gate C — near-launch integrations

- [ ] Configure the selected real SMS provider and test delivery/expiry/rate limits.
- [ ] Wire and certify the selected payment gateway in sandbox before enabling live money movement.
- [ ] Configure production domain, DNS, TLS, secrets, monitoring, alerts, and backup policy.
- [ ] Verify `/api/ready` returns 200 on the intended production configuration.

### Gate D — release decision

- [ ] Freeze and tag the exact release candidate SHA.
- [ ] Review migration SQL and backup/recovery evidence.
- [ ] Run smoke tests and business E2E on the real domain.
- [ ] Confirm monitoring and rollback operator are ready.
- [ ] Record explicit GO/NO-GO before opening public traffic.

## 6. Safety boundary

No production deployment, remote production D1 migration, real SMS activation, real payment activation, or production-data mutation was performed for this audit. Do not run `prisma db push --accept-data-loss`, `prisma migrate reset`, or any unreviewed production migration.


## 7. Follow-up after the initial audit snapshot

This section records work completed after the initial source review; it does not upgrade the release decision.

- **PR #26 merged:** Docker E2E now copies the complete PostgreSQL migration history into its build context and asserts the RateLimit/IdempotencyKey tables and VIP uniqueness indexes exist. The four workflows on the PR head completed successfully before merge.
- **PR #27 remains open:** production rate limiting now fails closed with HTTP 503 when the shared D1 store is unavailable, while non-production retains its development fallback. Unit tests cover allow, deny, production outage, and development fallback. CI, PostgreSQL CI, and Production readiness passed on the recorded head; Docker E2E failed on an OTP test because that run used the pre-PR-#26 workflow/migration context. Re-run Docker E2E against the updated main base before considering PR #27 mergeable.
- **Issue #22 remains open:** production idempotency fallback, wallet release exactly-once/recovery, and dedicated admin signing-secret enforcement remain unresolved.
- **Issue #24 remains open:** payment provider wiring, callback authenticity, financial validation, replay protection, reconciliation, and sandbox certification remain unresolved.
- **No live services activated:** no production deployment, remote production migration, real SMS, real payment, or production-data mutation was performed.

The Docker E2E failure is not waived. The next acceptance criterion is a fresh all-green run for PR #27 against the updated main, followed by focused review of every idempotency caller and the wallet release protocol.


## 8. Deeper concurrency review

A second adversarial pass identified correctness issues not resolved by the initial PR #27 scope:

- **Idempotency helper:** `withIdempotency()` in `src/lib/auth.ts` uses read → callback → upsert, so concurrent duplicate requests can both execute the side effect. Its broad catch also includes the callback and cache write; after an uncertain/partial side effect or cache-write failure, the fallback can invoke the callback again. The helper must be redesigned around an atomic claim/state machine and request fingerprint, or removed if proven unused. All call sites still need explicit enumeration. Tracked in issue #29 (with broader release hardening in issue #22).
- **Rate-limit window race:** the current main implementation conditionally increments an existing live row, then separately reads/upserts missing or expired rows. Concurrent first-hit/expiry requests can reset the counter multiple times. PR #27 only addresses store-outage fallback, not this algorithmic race. Tracked separately in issue #28; a single atomic provider-compatible operation and concurrency tests are required.
- **Admin secret:** `src/lib/admin-auth.ts` still allows production fallback from `ADMIN_JWT_SECRET` to `JWT_SECRET`; payload validation reduces token-confusion risk but does not provide cryptographic isolation. Production should require a dedicated secret and readiness must fail without it. Tracked in issue #22.
- **Wallet release:** the PENDING → AVAILABLE transition and wallet balance increment remain separate writes. Exactly-once recovery is still unproven; do not reverse the writes as a shortcut. Tracked in issue #22.

A new commit on PR #27 has triggered fresh CI against the updated base after PR #26 merged. At the time of this audit update, those four workflows are still in progress; no new pass is claimed.


## 9. Status update after security PR merge

- **PR #27 merged:** commit `f40fb789f5a0c3ac30352dbbedd7ed1e5e64c188`. All four workflows on the final PR head passed before merge: CI, PostgreSQL CI, Production readiness, and Docker E2E. Production rate-limit storage outages now return an explicit unavailable result; the four updated route handlers map that condition to HTTP 503. This closes only the outage fail-open finding, not the separate atomic window-initialization race in issue #28.
- **Issue #25 closed:** PR #26's complete PostgreSQL migration history fix is merged.
- **PR #12 ready for review:** the atomic escrow release helper now has an added SQLite integration test that executes the D1 SQL and checks exactly-once credit, insufficient pending balance, and rollback on a transaction-status write failure. Five workflows have been triggered on the updated PR head and were still running at this update. Do not merge until all five pass and the D1 runtime limitation is explicitly accepted or separately validated.
- **PR #16:** the dedicated Cloudflare Cron Worker remains stacked on PR #12. The D1 bind-order issue found during review was corrected on its branch and the SQLite integration test was added there too. It still needs a full CI run after PR #12 merges and it is retargeted to main. Its Wrangler config references the same D1 ID as the main app; verify the target environment and staging isolation before any deployment.
- **PR #19:** do not merge in parallel with PR #16. PR #16 is the preferred scheduled-worker direction because it uses direct D1 Cron execution, keyset pagination, and per-transaction failure isolation. PR #19 should be closed as superseded only after PR #16 passes review.
- **Open blockers:** issues #22 (wallet exactly-once recovery and dedicated admin secret), #28 (atomic rate-limit initialization and synchronous rateLimit call-site audit), and #29 (idempotency state machine, callback retry bug, and call-site inventory) remain open. Issue #24 (real payment provider integration) remains open.

**Release decision remains NOT READY.** No production deploy, production D1 migration, real SMS, live payment, or production-data mutation has been performed.


## 10. Mainline and follow-up PR consolidation

- **PR #12 merged:** commit `eba9451550743d93517712e594dadd8570977a5b`. All five workflows passed on its final head, including the SQLite integration test of the D1 escrow-release SQL.
- **PR #5 merged:** commit `4bd7a4cea29d7b80b9856524fb7e6b22d8332737`. Adds the admin secret local example and Cloudflare Worker rollback runbook. Its overlapping readiness-route change was removed so it could not overwrite the provider-aware gate.
- **PR #18 merged:** commit `ac8adb2062385c3e3a5d35f0020493b2038831ad`. Production readiness now requires provider-specific SMS credentials and a genuinely wired live payment integration; the production response sanitizes database errors. All four workflows passed on its final head.
- **PR #9 closed as superseded:** PR #18 owns the provider-readiness contract and deliberately distinguishes configured development providers from live-ready providers.
- **PR #27 merged:** commit `f40fb789f5a0c3ac30352dbbedd7ed1e5e64c188`; production rate-limit storage outages now fail closed with HTTP 503. Issue #28 still tracks atomic window initialization and sync-helper call-site audit.
- **Scheduled escrow worker consolidated into PR #30:** clean main-based branch, no divergence from main, includes keyset pagination, per-row failure isolation, both provider migrations, and the corrected D1 bind order plus SQLite integration test. CI has started; several workflows are still running. Old stacked PRs #16 and #19 were closed as superseded to prevent duplicate schedulers.
- **PR #13 prepay atomicity:** added D1 SQLite integration tests. The first run found an ambiguous unqualified `id` in joined Job/Wallet SQL; the marker was qualified and a fresh five-workflow run is in progress. Do not merge until all five pass.

The mainline is materially safer, but release remains blocked by open issues #22, #24, #28, #29 and by the remaining financial-flow PR reviews and real isolated D1 validation. No production deployment or service activation has occurred.


## 11. Latest mainline snapshot (2026-10-31)

Current main commit reviewed: `769b6499cccd15c13f1420eb7e425aa3652b09a1`.

- **PR #13 merged:** atomic pre-service payment/commission settlement is now on main. The D1 implementation was hardened to abort on unexpected idempotency-key collisions, and the SQLite integration tests caught and drove correction of an ambiguous joined `id` column before merge. All five workflows passed on the final PR head.
- **PR #30:** all five workflows passed. It remains intentionally open because the target Cloudflare account's isolated D1/Cron staging run has not been performed. The worker is not deployed; GET-triggered release remains enabled.
- **PR #32:** clean main-based atomic withdrawal request implementation. The first run exposed stale legacy route tests; the test suite has been updated to the idempotent request contract and the fail-closed 503 case. A fresh five-workflow run is in progress on head `43fa1d5d97f8c5c29c408de9a46547e1887c1b6c`.
- **PR #33:** clean main-based simulator gateway idempotency. CI, PostgreSQL CI, Cloudflare Build, and Production readiness passed; Docker E2E is still running. This does not implement a real payment provider.
- **PR #31 closed as superseded** by PR #33 after PR #13 changed the shared Prisma schema.
- **PR #14 remains an old stacked withdrawal branch**; PR #32 is its clean main-based replacement. Close PR #14 after PR #32 passes and is accepted.
- **Admin payout flow is not ready:** the admin implementation must capture a real external bank/provider trace reference before marking PAID. A generated UUID is not proof of payout. Dedicated admin signing-secret enforcement also remains open.
- **Currency decision remains owner-gated:** PR #17's USD canonicalization must not merge until the owner approves the currency contract and historical-value reconciliation.

Release remains **NOT READY**. Open release blockers include issues #22, #24, #28, and #29; isolated D1/Cron validation; admin payout reference and secret isolation; and the owner-approved currency contract. No production deploy, remote D1 migration, real SMS, or live payment has been performed.
