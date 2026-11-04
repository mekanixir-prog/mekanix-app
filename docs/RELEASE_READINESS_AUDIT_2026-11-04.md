# MEKANIX — Release Readiness Audit

**Audit date:** 2026-11-04  
**Audited branch:** `main`  
**Exact code baseline:** `2bf40e8642019550b2710bb171f2fd5ebe4116e8`  
**Repository:** [mekanixir-prog/mekanix-app](https://github.com/mekanixir-prog/mekanix-app)  
**Release decision:** **NO-GO** — the current mainline is CI-green, but financial integrity, release evidence, and repository governance are not complete.

This report supersedes earlier point-in-time release snapshots. It does not claim that a production deployment, live provider transaction, remote D1 staging rehearsal, or public launch has occurred.

## 1. Executive decision

The main branch is in a strong automated-build state. All eight workflows passed on the exact baseline commit:

| Workflow | Result |
|---|---|
| CI | PASS |
| Docker E2E | PASS |
| PostgreSQL CI | PASS |
| Production readiness | PASS |
| Cloudflare Build | PASS |
| CodeQL Security Analysis | PASS |
| Secret Scan | PASS |
| Dependency Security Audit | PASS |

Evidence: [main CI](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330037), [Docker E2E](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330042), [PostgreSQL CI](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330122), [Production readiness](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330214), [Secret Scan](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330126), [Dependency Security Audit](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330239), [CodeQL](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330259), [Cloudflare Build](https://github.com/mekanixir-prog/mekanix-app/actions/runs/41799330545).

**Interpretation:** green CI proves the configured checks passed against this commit and their test environments. It does not prove live SMS, real gateway callbacks, production secrets, DNS/TLS, remote database state, actual bank payout, backup restoration, or business-owner acceptance.

The production readiness endpoint is intentionally fail-closed. The successful workflow is not evidence that all real production environment flags and credentials have been configured. Missing financial attestations, secrets, provider readiness, shared rate-limit storage, admin provisioning, or escrow-worker deployment must continue to prevent production readiness.

## 2. Repository governance — release-process blocker

Read-only GitHub inspection found:

- `main` is reported as `protected: false`.
- Repository ruleset [main](https://github.com/mekanixir-prog/mekanix-app/rules/24984093), ID `24984093`, exists but has `enforcement: disabled`.
- The ruleset currently has zero required status checks, zero required approvals, and conversation-resolution enforcement disabled.
- Deletion and non-fast-forward rules exist in the disabled ruleset, so they are not currently enforced.
- The connected GitHub integration cannot read the branch-protection endpoint and has no ruleset-write operation. This report cannot enable those settings.

Tracking: [Issue #121](https://github.com/mekanixir-prog/mekanix-app/issues/121).

### Required-check design

The workflow trigger audit found six workflows that run on ordinary PRs:

1. CI
2. Production readiness
3. PostgreSQL CI
4. Docker E2E
5. CodeQL Security Analysis
6. Secret Scan

Two workflows are path-filtered:

- Cloudflare Build runs only when configured build/source paths change.
- Dependency Security Audit runs on lockfile/package changes (plus scheduled/manual/push events).

Do not make path-filtered checks unconditional required checks unless their triggers are changed. A skipped check can leave a PR blocked. Recommended policy: require the six always-on checks; either make Cloudflare Build run on every PR and then require it, or leave it path-filtered and optional; keep Dependency Security Audit path-filtered because Production readiness already runs `bun audit --audit-level=moderate` on PRs.

Do not require a second approval until a second maintainer exists. Configure an owner/admin bypass deliberately so a single-maintainer repository does not become unmergeable. After enabling the ruleset, verify it reports active and test both a normal code PR and a dependency PR.

## 3. Mainline changes and security PR disposition

### Merged

- **PR #112** — historical withdrawal actions are blocked unless withdrawal IRR provenance has been explicitly verified. Merged as `ad1f6af246369bfc071a28dc68589c3f6a0d1331`.
- **PR #120** — production readiness now requires strong user/admin/OTP secrets, shared rate-limit availability, admin provisioning, approved IRR pricing/provenance, withdrawal policy/provenance, and escrow-worker readiness. Merged as baseline `2bf40e8642019550b2710bb171f2fd5ebe4116e8`.

### Closed as superseded after current-main source review

- **PR #115** — current `src/lib/auth.ts` already includes the related User's status and role in the Session query and rejects a missing, inactive, or role-mismatched account. The proposed extra User lookup would duplicate a database read. The missing deleted-user regression test is carried in [PR #127](https://github.com/mekanixir-prog/mekanix-app/pull/127).
- **PR #116** — current OTP send/verify code already uses keyed HMAC phone identifiers with canonicalization and a 5-attempt / 10-minute per-phone verification budget, in addition to the IP budget. This is preferable to the PR's unkeyed SHA-256 key and 10-attempt / 5-minute policy. Regression tests for the current implementation are in PR #127.

### Still open

- **PR #113** — cookie-authenticated admin CSRF defense-in-depth. It was retargeted from the historical PR #112 branch to `main`. It is not merged. Its earlier five green checks predate the base retarget; fresh checks against the current base are required before any merge decision. The dedicated admin cookie is currently scoped to `/api/admin-panel`, while the generic `/api/admin` API is used by the bearer-token AdminApp path. Existing standalone admin login/logout/onboarding endpoints already have same-origin checks. Treat PR #113 as hardening, not as proof of a currently exploitable browser-cookie path.
- **PR #127** — test-only additions for deleted-user session invalidation and per-phone OTP verification throttling. At audit time, Secret Scan had passed and the other five triggered PR workflows were still running. Merge only after all applicable checks pass on its exact head.
- **PRs #71 and #73** — draft withdrawal changes. Do not merge independently: they overlap and contain assumptions from an older USD/decimal contract. #73's USD minimum/maximum and cent precision conflict with the approved integer-IRR contract.
- **PR #78** — broad 80-file financial branch, stacked on the old `feat/irr-money-core` branch. It is 260 commits ahead and 143 behind current `main`; do not merge wholesale. Extract and re-review small, current-mainline changes by bounded financial flow after the data and commercial contracts are settled.
- **PRs #124–#126** — Dependabot updates to GitHub Actions. Review individually; do not batch-merge major action upgrades without checking runner/runtime compatibility and exact CI.

## 4. Financial integrity — hard release blockers

The product owner approved the canonical unit on 2026-11-03:

- Persisted accounting amounts: **integer IRR**.
- Persian presentation: Toman may be displayed at the exact ratio **10 IRR = 1 Toman**.
- Toman is not the accounting or API persistence unit, except for a clearly named input adapter such as the CARE boundary.
- No FX conversion or magnitude-based inference is permitted for MEKANIX money.

This resolves the unit-selection decision. It does **not** resolve record-level provenance, approve prices, or authorize financial migration.

### Issue #81 — legacy money provenance

[Issue #81](https://github.com/mekanixir-prog/mekanix-app/issues/81) remains open.

Known cohorts include USD-labelled technician travel/inspection seed values in fields documented as IRR, ambiguous hourly rates, VIP demo prices, wallet balances/earnings without reliable unit metadata, service-package and JobPart prices, and invoices/payments whose IRR label may have been inherited from unclassified source amounts.

Required next work:

1. Build a read-only inventory/export with row IDs, timestamps, source records, writer paths, current currency metadata, and source lineage.
2. Classify each cohort using reliable evidence, not numeric magnitude.
3. Reconcile invoice → payment → commission → technician pending earnings → escrow release → withdrawal → payout.
4. Quarantine unknown rows. Never bulk-convert or relabel them.
5. Prepare a reviewed, reversible migration only after classification and backup/restore rehearsal.

No production/historical row conversion is authorized by the unit decision.

### Issue #99 — commercial policy

[Issue #99](https://github.com/mekanixir-prog/mekanix-app/issues/99) remains open and requires explicit owner decisions for:

- Separate rate cards for heavy machinery and passenger vehicles.
- Labor, inspection, visit, per-kilometer, emergency and regional pricing.
- Tax basis/rate and integer-IRR rounding.
- Platform commission basis and rounding.
- Technician gross/net, escrow hold and release conditions.
- VIP plan prices, duration, benefits, renewals and refunds.
- Integer-IRR withdrawal minimum/maximum, bank-only payout policy and fees.
- CARE's Toman input contract and exactly-once conversion boundary.

Existing seed values and pricing-engine defaults are not approved production prices.

### Issue #24 — authoritative payment lifecycle

[Issue #24](https://github.com/mekanixir-prog/mekanix-app/issues/24) remains open.

The payment-provider abstraction and sandbox adapter hardening do not yet constitute a complete authoritative production payment lifecycle. The current invoice payment route remains simulator-only and production-disabled. Required work includes persisted immutable payment attempts, server-derived integer-IRR amounts, provider initiation and server-side verification, ownership/order/currency/amount binding, replay/idempotency controls, purpose-specific invoice/VIP/prepay fulfillment, retryable outbox/recovery, and the matching commission/wallet/escrow ledger settlement.

Keep live gateway credentials, wallet credit, withdrawals and payouts disabled until the complete flow is implemented, tested and sandbox-certified.

## 5. Production readiness gates to preserve

The merged readiness gate must remain fail-closed until all relevant conditions are actually satisfied:

- Strong `JWT_SECRET`, `ADMIN_JWT_SECRET`, and dedicated `OTP_HASH_SECRET`.
- Available shared database-backed rate-limit store.
- Valid admin account or secure bootstrap provisioning.
- Explicit IRR pricing approval.
- Verified technician fee and JobPart source units.
- Owner-approved integer-IRR withdrawal policy and limits.
- Reconciled historical withdrawal records.
- Verified scheduled escrow-release worker deployment and operation.
- Real SMS/payment providers fully configured and wired before activation.
- Remote database configuration; no local SQLite file in production.

Do not set a provenance or pricing environment flag merely to turn readiness green. Each flag must follow its documented evidence and owner sign-off.

## 6. Work deliberately deferred until shortly before launch

The following are intentionally deferred and are not current code-development blockers:

- Production VPS/hosting purchase and provisioning.
- Production domain, DNS and HTTPS/TLS.
- Live SMS credentials and delivery template.
- Live payment merchant credentials and real transactions.
- Production monitoring endpoints and alert destinations.
- Final production database/Redis provisioning and secrets.

However, integration contracts and deployment procedures must be ready beforehand. Before public launch, still perform isolated staging, remote D1 binding/Cron verification for the escrow worker, backup/restore rehearsal, migration/rollback rehearsal, monitoring checks, real-provider smoke tests, and full business E2E. The fact that production infrastructure is deferred does not waive these launch gates.

## 7. Remaining release path

1. Owner manually enables the GitHub ruleset with a trigger-compatible required-check policy.
2. Finish PR #127 regression checks; review and merge only after exact-head CI is green.
3. Complete PR #113's fresh-base checks and decide whether to merge as defense-in-depth.
4. Split the stale financial PR #78 work into small current-mainline changes; keep PRs #71/#73 unmerged until their overlap and unit assumptions are resolved.
5. Complete issue #81 provenance classification and issue #99 commercial decisions.
6. Implement issue #24's authoritative payment and ledger lifecycle under the approved IRR contract.
7. Complete customer/technician/admin/CARE/warranty/refund/recovery E2E, failure injection, concurrency and performance testing.
8. Rehearse backup restore, migration and rollback in an isolated environment.
9. Produce a tagged Release Candidate and require all applicable workflows to pass on that exact SHA.
10. Activate hosting/domain/SMS/payment services shortly before launch, complete remote staging and real-provider smoke tests, then perform an explicit owner Go/No-Go.

## 8. Release evidence rule

Every completed gate must record its exact commit SHA, workflow/run URL, environment, test data, expected and actual result, reviewer/owner, and date. A green PR check is not a deployment; a local Docker test is not a remote staging rehearsal; a staging test is not a production test.

**Current release decision remains NO-GO.**