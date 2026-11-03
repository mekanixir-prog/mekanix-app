# MEKANIX — Release Readiness Audit

**Audit date:** 2026-11-03  
**Audited code baseline:** `f18c8acb667e073a0bda99799177f3f4f0d6fae9`  
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
| Wallet escrow release | PR #12, #13, #65 | Scheduled Worker, durable cursor, guarded D1 release helper, PostgreSQL coverage, and actual local D1 scheduled-event test are merged; remote Cloudflare D1/Cron verification remains a pre-launch gate |
| VIP payment-purpose binding | PR #67 | VIP activation now requires the exact verified VIP gateway log, owner, payment link, amount, and IRR currency; production payment remains disabled |
| CARE extra-cost validation | PR #68 | Server validates integer prices/quantity/total and binds a supplied Finding to the same booking; atomic proposal creation is re-opened on current main in PR #79 |
| Service-request assignment | PR #69 | Ownership, technician verification/availability/specialty, request claim, technician capacity, and Job creation are enforced atomically |
| CARE extra approval decisions | PR #70 | Approval/rejection, booking, Finding, and timeline changes use compare-and-set and one transaction/batch |
| Financial unit audit | PR #74 | Documentation-only audit is merged; integer IRR is a recommendation, not a confirmed product-owner decision. Issue #81 remains open; no financial runtime behavior changed |
| Financial data provenance and API flow audits | PR #76, #77 | Documentation-only inventories of source units, seed risks, money-flow validation, and migration gates are merged; no runtime money behavior changed |
| Gateway simulator production guards | PR #83 | Test-only regression coverage merged; `/api/gateway/initiate` and `/api/gateway/verify` must return 404 before auth/DB access in production |
| Payment adapter verification contract | PR #66 (Draft) | Sandbox-only IDPay/Zarinpal adapter hardening; exact current head passed all five required workflows; still disconnected from payment routes |
| Payment lifecycle contract | PR #86 (merged) | Design-only lifecycle, idempotency, callback, fulfillment/outbox and test requirements; all four applicable workflows passed; no monetary unit or runtime behavior approved |

## 2. Verified CI evidence

- PR #55 merged after all five applicable workflows passed on its exact head.
- PR #57 merged after all five applicable workflows passed on its exact head.
- PR #59 merged with route-specific CARE idempotency, atomic writes, and reconciliation tests.
- PR #63 merged as `5ca2651923af888547946ad5308e507dd4519266` after all five applicable workflows passed on its exact head: CI, Cloudflare Build, Production readiness, PostgreSQL CI, and Docker E2E.
- PR #63 includes 100-concurrent-same-key D1/SQLite integration simulations and 80-concurrent PostgreSQL integration tests for service requests and claims, payload mismatch/replay behavior, and injected rollback failures.
- PR #67 merged as `e6c03dcb6ff7316e98fec73092cd9307855fb3c1`; all five workflows passed on its exact head before merge.
- PR #68 merged as `49e602b5f0413f1e0cc8949708c03dab3709cddd`; all five workflows passed on its exact head before merge.
- PR #69 merged as `2662e4c671e3f0a07958d941954744ef4fd8d2d3`; all five workflows passed on its exact head before merge.
- PR #70 merged as `54c9466bac054e8163c8a5859d28227af4fb1983`; all five workflows passed on its exact head before merge.
- PR #79 merged as `1380597c7a0616a18896c2a7f295a92629c337b4` after all five workflows passed on its current-mainline head. It supersedes the divergent pre-squash PR #72, which is now closed.
- PR #80 merged as `2f3b5b750377f07657cc7db853b12338a8cfaa4a` after all five required workflows passed on a branch containing current main.
- PR #65 merged as `97d50eb000e39e087eaea6403b23f9fe262b9d76` after all five required workflows passed on its current-main head; Cloudflare Build also ran the actual scheduled Worker twice against local D1 and verified exactly one RELEASE ledger row, correct balances/status, and guard cleanup. No remote Cloudflare resources were provisioned.
- PR #74 merged as `28d13e32c2046ed2743d549a8ab3c24bdd972054` after all four documentation-branch workflows passed. It records the financial-unit audit and recommended target only; it does not approve IRR or change runtime behavior.
- PR #76 merged as `18614ea43bb050ad97b9ca4309ba6fab8fa0eac8` after all four workflows passed on its main-synced head; it records monetary data provenance, seed risks, and migration safeguards.
- PR #77 merged as `19a4bb1023aedf5814f9dd4a8fa8bb53ade2a1f9` after all four workflows passed on its main-synced head; it records API money-flow sources, validation boundaries, and fail-closed sequencing.
- PR #83 merged as `ab99e97dd3023a648a24308c8e73aecaa17e6234` after all four applicable workflows passed; it adds production-guard regression tests for both gateway simulator routes and changes no runtime payment behavior.
- PR #84 merged as `e97c638065d5b96ee055f4add8681e8ccfd01846`; its four applicable documentation-branch workflows passed.
- PR #85 merged as `63095f5daffbe950ef707e2a0521b8ffd28a22c1`; all four applicable workflows passed on its exact documentation-only head. The latest main CI also passed all five required workflows on the pre-merge main baseline.
- PR #86 merged as `f18c8acb667e073a0bda99799177f3f4f0d6fae9` after all four applicable workflows passed on its exact head; it adds a design-only payment lifecycle contract and changes no runtime financial behavior.
- Main CI passed all five required workflows on `ab99e97dd3023a648a24308c8e73aecaa17e6234`.
- PRs #75 and #78 remain Draft and unwired. Their IRR-specific implementation assumptions must not be adopted until the product owner approves the canonical monetary unit and provenance/migration gates are satisfied.
- Issue #81 is open as a release blocker for the monetary-unit mismatch across schema, wallet accounting, UI formatting, invoice/payment metadata, and Iranian gateway amounts. PRs #71/#73 remain unmerged pending a canonical currency contract and consolidation; PRs #75/#78 remain Draft pending explicit owner approval.
- Issue #52 is closed as completed for code-level remediation. Issue #29 is closed as not planned for a generic callback helper because the repository audit found no production call sites; route-specific contracts are used instead.
- Issue #28 is closed as completed for code-level rate-limit atomicity; real Cloudflare D1 runtime validation remains a separate operational gate.

## 3. Open code and operations work

### 3.1 Scheduled wallet escrow Worker — PR #65 (merged; remote staging still pending)

- PR #43 was closed as superseded. PR #65 is merged; its final head was `7ef36d62b65200c36d946bf1c2877fd614b78e74` and its merge commit is `97d50eb000e39e087eaea6403b23f9fe262b9d76`.
- PR #65 adds the 15-minute Cron Trigger, keyset pagination, durable cross-run cursor, per-row failure isolation, shared atomic D1 release helper, PostgreSQL concurrency/ledger rollback coverage, and a guarded synthetic D1 staging fixture. The latest revision replaces the fragile in-statement `changes()` assertion with a transaction-scoped `WalletReleaseGuard` row; the guard is inserted and deleted inside the same D1 batch and has a NOT NULL rollback assertion.
- The committed Wrangler config contains an all-zero D1 placeholder. CI uses local D1 only; no Cloudflare Worker has been deployed and no real Cloudflare D1 binding/Cron Trigger has been verified.
- Earlier PR #65 heads exposed a D1/SQLite assertion incompatibility. The latest head replaces `changes()`-based in-batch assertions with a dedicated rollback guard table in both SQLite and PostgreSQL migration histories, and regression tests cover silently ignored wallet, transaction, and ledger writes.
- Cloudflare Build applies the full local D1 migration history, starts the actual scheduled Worker with Wrangler's local `--test-scheduled` mode, invokes the schedule twice, and verifies one AVAILABLE transition, correct wallet balances, exactly one RELEASE ledger row, and no leaked guard row. All five workflows passed on the final PR head before merge.
- Remote D1 staging, binding/Cron Trigger observation, and wallet/ledger reconciliation are pre-launch gates before production enablement. Keep `WALLET_RELEASE_SCHEDULED=true` unset until that remote evidence and owner approval exist.

### 3.2 Real payment provider — issue #24

- PR #66 remains Draft and is refreshed on the current audited code baseline. Its current head `361fbb6314401b327f6ea2f7ab5273bb25063119` hardens IDPay/Zarinpal adapter verification, requires persisted order IDs and safe integer provider amounts, and defaults both adapters to sandbox. All five required workflows passed on this exact head; the adapters remain disconnected from payment routes.
- PR #85's merge updates this audit's baseline only; it does not change runtime payment behavior. See `PAYMENT_LIFECYCLE_CONTRACT_2026-11-03.md` for the proposed implementation contract (design only; pending issue #81 and settlement-rule approval).
- PR #66 does not connect provider adapters to the payment routes and does not resolve invoice-to-wallet settlement or issue #81.
- Zarinpal/IDPay adapter scaffolding exists, but the authoritative initiation → persisted attempt → provider verification → business settlement lifecycle is not wired.
- `/api/payments`, `/api/gateway/initiate`, `/api/gateway/verify`, and VIP/prepay simulator paths remain unavailable in production.
- Provider selection, server-side callback verification, amount/currency/order ownership checks, duplicate/replay handling, refund behavior, and sandbox evidence remain open.
- The cross-layer monetary-unit mismatch is tracked separately in issue #81; no provider or payout work may be activated until its accounting and conversion boundary is resolved.
- The invoice simulator currently marks an invoice PAID and completes the Job but does not create the technician's commission/net escrow WalletTransaction or matching ledger entries. Invoice-to-wallet settlement remains a blocker under issue #24.
- No live payment, refund, bank transfer, or provider credential activation has occurred.

### 3.3 SMS / OTP

- Production OTP now fails closed without a configured real provider.
- Vendor selection, credentials, sender/template, delivery monitoring, alerting, and a real phone smoke test remain pre-release tasks.
- Staging intentionally uses the console provider and must return a fail-closed result; it is not evidence of production SMS readiness.

### 3.4 Staging, backup/restore, performance, and security scans

- Docker/PostgreSQL staging configuration exists, but no actual VPS staging deployment or Release Candidate smoke test has been performed in this session.
- PR #64 is merged. It adds encrypted GPG backup support, no connection-string logging, a fail-safe empty-target restore, a disposable restore-test database guard, Docker/PostgreSQL staging configuration, protected staging environment-file loading, shell/Compose checks, and a PostgreSQL CI restore rehearsal. The encrypted restore utility and full schema/row/index/constraint comparison passed on the final PR head.
- Docker E2E checks also assert the additive CARE/service-request/claim idempotency indexes and schema objects.
- k6 load test and OWASP ZAP baseline scripts are prepared, but no staging measurements or scan report exist. p95/p99, failure rate, resource use, and ZAP findings therefore remain unverified.
- A production restore rehearsal must use a protected backup, a separate disposable target, and explicit approval. The automated test script refuses production as a source.

### 3.5 Production secrets and rollout controls

- No production `ADMIN_JWT_SECRET`, SMS secret, payment secret, or other production secret was configured by this work.
- No production migration, D1 mutation, Worker deployment, domain/hosting activation, or production environment change was performed.
- Currency contract and historical-value reconciliation remain owner-gated; no backfill should run without explicit approval.
- Production migrations require backup, successful restore rehearsal, reviewed rollout plan, maintenance window, and explicit release approval.

## 4. Release sequence

1. PR #64 is complete and merged; retain its backup/restore and staging controls as the operational baseline.
2. PR #65 is merged after all five workflows and the local scheduled-Worker/D1 integration passed. Before production enablement, provision an isolated Cloudflare D1 staging database, verify the real binding and Cron Trigger, observe scheduled runs, and reconcile wallet/ledger effects.
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
