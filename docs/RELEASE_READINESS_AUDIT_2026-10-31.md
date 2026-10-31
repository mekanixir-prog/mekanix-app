# MEKANIX — Release Readiness Audit

**Audit date:** 2026-10-31  
**Audited main commit:** `901d1f889703cce0c9acd8a189841b49b30e8847`  
**Repository:** `mekanixir-prog/mekanix-app`  
**Decision:** **NOT READY FOR PRODUCTION**

This report supersedes older point-in-time release and post-PR3 audit documents. It records only verified merge/CI evidence and explicitly separates automated tests from real Cloudflare, provider, and production operations.

## 1. Verified mainline changes

| Area | Merged change | Current boundary |
|---|---|---|
| Atomic escrow release | PR #12 | D1 SQL and Prisma transaction implementations are on main; scheduled Worker rollout remains gated by PR #43 and isolated D1 staging |
| Prepay / commission settlement | PR #13 | Atomic D1/Prisma path and unique ledger keys are merged; simulator-only, not a live payment gateway |
| Withdrawal request | PR #32 | Durable request idempotency and atomic wallet debit are merged |
| Admin withdrawal operations | PR #36 | Conditional state transitions, atomic refund/payout records, mandatory external bank trace reference, and production admin-secret isolation are merged |
| Shared rate limiting | PR #35 | Atomic database upsert, bounded counter, and production fail-closed behavior are merged |
| Global auth rate-limit mapping | PR #38 | `requireAuth()` maps shared-store outage to 503 before session lookup |
| PostgreSQL rate-limit parity | PR #40 | Real PostgreSQL concurrency tests are merged |
| Gateway simulator verification | PR #33 | Unique gateway payment reference and replay/recovery handling are merged; production still returns 404 |
| Generic idempotency / offline retries | PR #39 | Unsafe unused generic helper removed; offline retries limited to endpoint-specific durable contracts; ambiguous failures require reconciliation |

## 2. CI evidence

The following five-workflow PR heads passed before merge: PR #33, #35, #36, #38, and #39. PR #40 passed its four applicable workflows (CI, Production readiness, PostgreSQL CI, Docker E2E).

**PostgreSQL evidence from PR #40:** 41 test files and 529 tests passed. The new real-PostgreSQL concurrency suite passed both tests:
- 80 concurrent first-hit requests: exactly the configured seven allowed, with the counter saturated at eight.
- 80 concurrent expiry-boundary requests: one new window, exactly seven allowed, counter saturated at eight.

SQLite integration tests cover the same rate-limit concurrency cases and the D1 escrow/withdrawal SQL paths. These are provider-parity tests; they do not replace a real Cloudflare D1 staging run.

**PR #43 — scheduled escrow Worker:** draft. At this audit snapshot, CI and Cloudflare Build are green; Docker E2E, PostgreSQL CI, and Production readiness are still running. No final PR result is claimed yet.

## 3. Production blockers

### 3.1 Cloudflare D1 and scheduled escrow

- PR #43 adds the 15-minute Cron Worker, keyset pagination, per-row failure isolation, the shared atomic D1 helper, and the `(status, holdUntil, id)` index.
- The main app retains the transitional GET-triggered release until `WALLET_RELEASE_SCHEDULED=true`.
- **Do not set this flag early.** First deploy the Worker to an isolated staging environment, apply the index migration there, observe at least one successful Cron Trigger run, and reconcile matured PENDING rows against AVAILABLE releases.
- No Worker has been deployed and no production D1 migration has been executed.

### 3.2 Real payments and settlement

- PR #33 hardens only the development simulator. `/api/gateway/verify` remains unavailable in production.
- The generic `/api/payments` and prepay flows are not a live bank/payment provider integration.
- Issue #24 remains open for provider wiring, signed callback verification, amount/currency/order ownership checks, replay protection, settlement reconciliation, and sandbox evidence.
- No live payment, gateway credential, or bank transfer was activated.

### 3.3 SMS / OTP

- Production readiness still requires a real provider-specific SMS integration and credentials.
- No real SMS provider was activated and no production OTP delivery test was performed.

### 3.4 Admin security and payout operations

- Production dedicated admin JWTs require `ADMIN_JWT_SECRET` of at least 32 bytes. It must be configured securely before deployment; no production secret was set during this work.
- Admin payout records require the real external bank transfer tracking reference. The application records evidence of a manually executed transfer; it does not initiate a bank transfer.
- Reconcile every PAID withdrawal against the bank statement/provider record before release.

### 3.5 Offline reconciliation and idempotency

- PR #39 removed the unsafe generic helper because no production endpoint used it.
- Automatic offline retries are limited to wallet withdrawal, prepay, and simulator gateway verification, each with route-specific durable idempotency.
- Ambiguous network/5xx outcomes for other queued actions are retained for manual reconciliation. A user-facing reconciliation screen and broader route-specific contracts remain outstanding.
- Issue #29 remains open; do not describe the platform as globally exactly-once.

### 3.6 Rate-limit runtime validation

- PR #35 and #38 make the shared rate limiter atomic and fail closed; PR #40 adds real PostgreSQL concurrency evidence.
- Issue #28 remains open until isolated Cloudflare D1 staging verifies the same upsert behavior, production bindings, and outage handling under the actual Worker runtime.

### 3.7 Currency contract

- Any USD canonicalization or historical-value conversion remains owner-gated. Do not merge or backfill currency changes until the canonical unit, display policy, and historical reconciliation are explicitly approved.

## 4. Required release sequence

1. Finish PR #43's five CI workflows; review the exact final head and migration diff.
2. Deploy the escrow Worker only to isolated Cloudflare staging; verify D1 binding, Cron Trigger, logs, pagination, failure isolation, and no double credits.
3. Only after successful staging and at least one observed scheduled run, set `WALLET_RELEASE_SCHEDULED=true` on the main application Worker.
4. Complete provider-specific SMS and payment integrations in sandbox; validate signed callbacks, ownership, amount, currency, replay, refunds, and reconciliation.
5. Configure and verify `ADMIN_JWT_SECRET` and all production secrets without exposing them in Git or logs.
6. Complete manual payout reconciliation and the offline action reconciliation UI.
7. Obtain explicit approval for the currency contract and historical-value handling.
8. Apply production migrations only after backup, restore rehearsal, reviewed rollout plan, and explicit release approval.
9. Deploy in a controlled window, run smoke tests for OTP, roles, vehicle registration, service request, technician assignment, wallet, withdrawal, admin operations, and provider callbacks; retain a tested rollback path.

## 5. Explicitly not performed

- No production deployment.
- No production D1 migration or production-data mutation.
- No Cron Worker deployment or production `WALLET_RELEASE_SCHEDULED` change.
- No real SMS delivery or provider credential activation.
- No live payment, refund, or bank transfer.
- No production admin secret configuration.

**Final decision: NOT READY.** Automated checks demonstrate code/build/test properties for their exact commits and test environments only. Production readiness still depends on external D1 staging, provider integration, secrets, operational reconciliation, and owner approvals.
