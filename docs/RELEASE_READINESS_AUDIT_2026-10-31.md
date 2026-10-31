# MEKANIX — Release Readiness Audit

**Audit date:** 2026-10-31  
**Audited main commit:** `1691c87970835af37577946e422d66e26e3baf4f`  
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

**PR #43 — scheduled escrow Worker:** draft, exact head `5e2b16de5f0f2c8f8931d884b83e943b3d0e09d9`. All five workflows (CI, Cloudflare Build, Production readiness, PostgreSQL CI, Docker E2E) have completed successfully on that head. The PR remains a draft because CI does not validate the target Cloudflare account, actual D1 binding, Cron Trigger deployment, or financial reconciliation. No staging deployment has been performed.

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

### 3.7 Booking, service-request, and claim recovery

- Issue #52 records three additional multi-write create flows that lack a complete route-specific recovery contract: CARE booking creation, service-request creation (including ad-hoc vehicle creation), and insurance claim creation.
- CARE booking creation writes the booking, pricing snapshot, booking link, and timeline event sequentially; a mid-flow failure can leave partial state and an ambiguous retry can create a duplicate.
- Service-request creation can create an ad-hoc vehicle before the request, then sends notifications sequentially; ambiguous retries can create duplicate vehicles/requests.
- Insurance claim creation can commit the claim while the policy status update fails; it has no claim idempotency/status lookup contract.
- PR #50's merged reconciliation center deliberately keeps unsupported operations behind manual review. It does not invent server status or enable automatic retry for these endpoints.
- Treat issue #52 as a release blocker for broad offline mutation sync and for enabling these flows at production scale until route-specific idempotency, atomicity/recovery, read-only status endpoints, and failure-injection tests are complete.

### 3.8 Production SMS delivery safety

- Issue #53 records that the old SMS abstraction could fall back to console logging in production when SMS_PROVIDER was missing/invalid, and the OTP endpoint could return success even when provider delivery failed.
- PR #55 makes missing/console/unsupported/incomplete SMS configuration fail closed before OTP persistence; delivery failures consume the newly stored OTP hash and return 502/503; recipient, OTP, and provider error payloads are withheld from logs. Its Docker E2E gate now asserts production returns 503 and leaves the OtpCode table empty when no real provider is configured.
- PR #55 is open on clean current-mainline head `7ec3e874fb817be92c32754c578111859744796d`; all five workflows are pending/in progress at this audit snapshot. No result is claimed until they complete. PR #54 was closed as superseded after PR #50 merged.
- This does not activate a provider. Select the SMS vendor and set credentials, sender/template, delivery monitoring, and alerting only at the planned pre-release activation gate.

### 3.9 Currency contract

- Any USD canonicalization or historical-value conversion remains owner-gated. Do not merge or backfill currency changes until the canonical unit, display policy, and historical reconciliation are explicitly approved.

## 4. Required release sequence

1. Keep PR #43 in draft until its isolated D1/Cron staging gate is completed; all five workflows are green on the recorded head, but the target Cloudflare account has not been exercised.
2. Deploy the escrow Worker only to isolated Cloudflare staging; verify D1 binding, Cron Trigger, logs, pagination, failure isolation, and no double credits.
3. Only after successful staging and at least one observed scheduled run, set `WALLET_RELEASE_SCHEDULED=true` on the main application Worker.
4. Complete provider-specific SMS and payment integrations in sandbox; validate signed callbacks, ownership, amount, currency, replay, refunds, and reconciliation.
5. Configure and verify `ADMIN_JWT_SECRET` and all production secrets without exposing them in Git or logs.
6. Complete manual payout reconciliation; verify PR #50's merged reconciliation center in isolated staging and keep unsupported operations behind manual review.
7. Resolve issue #52's multi-write booking/request/claim recovery risks before enabling broad offline mutation sync or production-scale create flows.
8. Merge PR #55 only after all five workflows pass; keep real SMS provider activation separate and owner-controlled until pre-release.
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
