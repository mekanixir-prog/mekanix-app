# MEKANIX — Release Readiness Audit

**Audit date:** 2026-11-01  
**Audited mainline baseline:** `5ca2651923af888547946ad5308e507dd4519266`  
**Repository:** `mekanixir-prog/mekanix-app`  
**Decision:** **NOT READY FOR PRODUCTION**

This audit separates verified code/CI evidence from staging and provider operations. A green workflow proves only the tested commit and environment; it does not prove that a live Cloudflare account, payment provider, or SMS vendor is configured correctly.

## 1. Verified mainline changes

| Area | Merged change | Current boundary |
|---|---|---|
| Production SMS fail-closed | PR #55 | Console/missing/unsupported provider config cannot issue a successful production OTP; real vendor activation and delivery smoke test remain separate |
| Withdrawal reconciliation | PR #57 | COMMITTED requires matching immutable ledger proof, reference, and exact debit amount; issue #49 closed |
| CARE booking recovery | PR #59 | Booking, pricing snapshot/link, and initial timeline event are atomic on Prisma or D1; status lookup and retry-key support added |
| Service request recovery | PR #63 | Optional ad-hoc vehicle + request are atomic; notifications are post-commit; status lookup and durable retry key added |
| Insurance claim recovery | PR #63 | Claim + policy transition are atomic; eligibility guard and status lookup added |
| Offline reconciliation | PR #50, extended by PR #63 | Persian reconciliation center checks route-specific server status; unsupported/ambiguous actions remain behind manual review |
| Rate-limit atomicity | PR #35, #38, #40 | Atomic initialization and fail-closed outage handling; PostgreSQL concurrency tests merged |
| Wallet escrow release | PR #12, #13 | Atomic D1/Prisma release logic exists; refreshed scheduled Worker is PR #65 (draft) and requires isolated Cloudflare staging |

## 2. Verified CI evidence

- PR #55 merged after all five applicable workflows passed on its exact head.
- PR #57 merged after all five applicable workflows passed on its exact head.
- PR #59 merged with route-specific CARE idempotency, atomic writes, and reconciliation tests.
- PR #63 merged as `5ca2651923af888547946ad5308e507dd4519266` after all five applicable workflows passed on its exact head: CI, Cloudflare Build, Production readiness, PostgreSQL CI, and Docker E2E.
- PR #63 includes 100-concurrent-same-key D1/SQLite integration simulations and 80-concurrent PostgreSQL integration tests for service requests and claims, payload mismatch/replay behavior, and injected rollback failures.
- Issue #52 is closed as completed for code-level remediation. Issue #29 is closed as not planned for a generic callback helper because the repository audit found no production call sites; route-specific contracts are used instead.
- Issue #28 is closed as completed for code-level rate-limit atomicity; real Cloudflare D1 runtime validation remains a separate operational gate.

## 3. Open code and operations work

### 3.1 Scheduled wallet escrow Worker — PR #65

- PR #43 was closed as superseded; PR #65 refreshes the implementation on the audited mainline baseline and remains a draft.
- PR #65 adds the 15-minute Cron Trigger, keyset pagination, durable cross-run cursor, per-row failure isolation, shared atomic D1 release helper, PostgreSQL concurrency/ledger rollback coverage, and a guarded synthetic D1 staging fixture.
- The committed Wrangler config contains an all-zero D1 placeholder. CI uses local D1 only; no Cloudflare Worker has been deployed and no real Cloudflare D1 binding/Cron Trigger has been verified.
- The current PR #65 head is still undergoing its five CI workflows; do not treat prior/cancelled runs as evidence for the latest head.
- Do not set `WALLET_RELEASE_SCHEDULED=true` until an isolated D1 staging database has been migrated, the Worker deployed, at least one scheduled run observed, and matured PENDING rows reconciled against AVAILABLE releases.

### 3.2 Real payment provider — issue #24

- Zarinpal/IDPay adapter scaffolding exists, but the authoritative initiation → persisted attempt → provider verification → business settlement lifecycle is not wired.
- `/api/payments`, `/api/gateway/initiate`, `/api/gateway/verify`, and VIP/prepay simulator paths remain unavailable in production.
- Provider selection, server-side callback verification, amount/currency/order ownership checks, duplicate/replay handling, refund behavior, and sandbox evidence remain open.
- No live payment, refund, bank transfer, or provider credential activation has occurred.

### 3.3 SMS / OTP

- Production OTP now fails closed without a configured real provider.
- Vendor selection, credentials, sender/template, delivery monitoring, alerting, and a real phone smoke test remain pre-release tasks.
- Staging intentionally uses the console provider and must return a fail-closed result; it is not evidence of production SMS readiness.

### 3.4 Staging, backup/restore, performance, and security scans

- Docker/PostgreSQL staging configuration exists, but no actual VPS staging deployment or Release Candidate smoke test has been performed in this session.
- PR #64 is the operational-hardening PR. It adds encrypted GPG backup support, no connection-string logging, fail-safe empty-target restore, disposable restore-test database guard, Docker/PostgreSQL staging configuration, shell/Compose checks, and a PostgreSQL CI restore rehearsal.
- A PostgreSQL-client/server major-version mismatch and then a noninteractive PGDG key-import issue were found in the rehearsal workflow and corrected on the PR branch; the latest exact head is queued for full CI. These changes are not yet mainline evidence.
- Docker E2E checks also assert the additive CARE/service-request/claim idempotency indexes and schema objects.
- k6 load test and OWASP ZAP baseline scripts are prepared, but no staging measurements or scan report exist. p95/p99, failure rate, resource use, and ZAP findings therefore remain unverified.
- A production restore rehearsal must use a protected backup, a separate disposable target, and explicit approval. The automated test script refuses production as a source.

### 3.5 Production secrets and rollout controls

- No production `ADMIN_JWT_SECRET`, SMS secret, payment secret, or other production secret was configured by this work.
- No production migration, D1 mutation, Worker deployment, domain/hosting activation, or production environment change was performed.
- Currency contract and historical-value reconciliation remain owner-gated; no backfill should run without explicit approval.
- Production migrations require backup, successful restore rehearsal, reviewed rollout plan, maintenance window, and explicit release approval.

## 4. Release sequence

1. Complete CI for PR #64 and merge only if all four applicable workflows pass on the exact head.
2. Complete PR #65's five workflows; keep it draft until isolated Cloudflare D1 staging evidence exists, then deploy only to that staging database.
3. Observe scheduled escrow runs and reconcile ledger/balance effects; keep the production schedule flag disabled until separately approved.
4. Select the payment provider and complete sandbox initiation, signed/server-side verification, replay, wrong-amount/currency, timeout, duplicate callback, and refund tests.
5. Select and configure the SMS provider in staging; test delivery, rate limits, provider outage, monitoring, and alerting.
6. Deploy the exact Release Candidate to isolated VPS staging; run k6, ZAP, backup/restore, health/readiness, and rollback rehearsals; attach evidence.
7. Review production secrets, admin access, payout reconciliation, currency contract, migration plan, backup retention/encryption, and incident rollback plan.
8. Obtain explicit owner approval before any production secret activation, migration, domain/hosting switch, SMS/payment activation, or deployment.

## 5. Explicitly not performed

- No production deployment.
- No production database migration or data mutation.
- No Cloudflare D1 staging database or Cron Worker deployment.
- No real SMS delivery or provider activation.
- No live payment, refund, or bank transfer.
- No production secret configuration.
- No measured k6 load test, ZAP report, or production restore rehearsal.
- No Release Candidate tag or public release.

**Final decision: NOT READY.** Code-level reliability work is materially advanced, but actual Cloudflare staging, payment/SMS provider validation, operational performance/security evidence, and explicit release approval remain mandatory.
