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

- **Idempotency helper:** `withIdempotency()` in `src/lib/auth.ts` uses read → callback → upsert, so concurrent duplicate requests can both execute the side effect. Its broad catch also includes the callback and cache write; after an uncertain/partial side effect or cache-write failure, the fallback can invoke the callback again. The helper must be redesigned around an atomic claim/state machine and request fingerprint, or removed if proven unused. All call sites still need explicit enumeration. Tracked in issue #22.
- **Rate-limit window race:** the current main implementation conditionally increments an existing live row, then separately reads/upserts missing or expired rows. Concurrent first-hit/expiry requests can reset the counter multiple times. PR #27 only addresses store-outage fallback, not this algorithmic race. Tracked separately in issue #28; a single atomic provider-compatible operation and concurrency tests are required.
- **Admin secret:** `src/lib/admin-auth.ts` still allows production fallback from `ADMIN_JWT_SECRET` to `JWT_SECRET`; payload validation reduces token-confusion risk but does not provide cryptographic isolation. Production should require a dedicated secret and readiness must fail without it. Tracked in issue #22.
- **Wallet release:** the PENDING → AVAILABLE transition and wallet balance increment remain separate writes. Exactly-once recovery is still unproven; do not reverse the writes as a shortcut. Tracked in issue #22.

A new commit on PR #27 has triggered fresh CI against the updated base after PR #26 merged. At the time of this audit update, those four workflows are still in progress; no new pass is claimed.
