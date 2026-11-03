# Current Release Gate — 2026-11-02

This file is the current release-status source of truth. It is a readiness record, not permission to merge, deploy, activate production providers, or spend on infrastructure.

## Executive status

**Release: BLOCKED / NOT PRODUCTION-READY.**

- PR #75 (`feat/irr-money-core`) is Draft and targets `main`. Its five required workflows are green on head `e1246bc4e869233e5c05c8958ce599fce748a9ff`: CI, PostgreSQL CI, Production Readiness, Docker E2E, and Cloudflare Build.
- PR #78 (`fix/irr-display-dashboard-withdrawal`) is Draft and stacked on PR #75. Current verified head: `a4952948fb92a7a5e7a3a975eb2b61f7ddf6e4bc`. All five required workflows pass on this exact head: CI, PostgreSQL CI, Production Readiness, Docker E2E, and Cloudflare Build. PostgreSQL CI: 724 tests across 61 files, 0 failures. Security audit: 0 critical/high findings; 3 moderate advisories remain (glob, minimatch, PrismJS) and require explicit risk acceptance or further remediation before Go/No-Go.
- No merge, deployment, production database change, DNS change, provider activation, or credential change has been performed.

## PR dependency and conflict map

### Money / wallet / payment

1. **PR #75 — canonical integer IRR primitives**
   - Base: `main`.
   - Review and merge first, only after owner approval. This is the base of PR #78.
   - The module is policy-neutral: safe integer validation, strict parsing, overflow-safe addition, rational multiplication with explicit rounding, and presentation-only formatting.

2. **PR #78 — financial correctness and fail-closed behavior**
   - Base: PR #75 (`feat/irr-money-core`); do not merge before #75.
   - Current scope includes wallet provenance gates/redaction, integer IRR prepay calculations, explicit half-up commission rounding, bank-only withdrawals with checksum-validated Sheba, D1 rollback guards for withdrawal creation/rejection/settlement, VIP gateway-purpose verification, and atomic Prisma/D1 VIP subscription replacement.
   - It also includes authorization hardening for job participation/state transitions and admin-only dashboard business intelligence.
   - Keep Draft until all five workflows are green on the final head, the stacked branch is reconciled with main, and the owner approves.

3. **PR #67 — VIP gateway-purpose binding**
   - Its relevant code is ported into PR #78: verified gateway attempt checks, exact user/payment/purpose/amount/currency binding, atomic subscription helper, one-active-per-user migrations for SQLite/D1 and PostgreSQL, and tests.
   - Do not merge #67 separately while the same changes are in #78. After #78 is merged and verified, close #67 as superseded or retain it only if a diff review finds missing content.

4. **PR #71 — bank-only payout and D1 rollback guards**
   - Its relevant code is ported into PR #78: bank-only payout, Sheba MOD-97 validation, admin approval/PAID destination checks, explicit D1 rollback guards, and unit/SQLite integration tests.
   - Do not merge #71 separately while the same changes are in #78. Reconcile by diff before closing it as superseded.

5. **PR #73 — withdrawal limits and precision**
   - This PR adds a USD-oriented $5 minimum, $10,000 maximum, and two-decimal precision. Those rules conflict with the integer-IRR contract in PR #75.
   - Its bank-only and Sheba ideas are already covered by the PR #71 changes ported to #78. **Do not merge #73 as-is.** Any IRR minimum/maximum must be separately specified and approved; do not translate USD limits implicitly.

6. **PR #66 — provider adapter verification contract**
   - Adapter-level hardening only. It does not wire production checkout/callback/verification into the authoritative payment lifecycle and does not enable live payments.
   - Review separately; keep production payment routes fail-closed until a complete provider lifecycle and sandbox certification exist.

7. **PR #65 — scheduled wallet escrow worker**
   - Draft, based on current mainline. Review its cursor, retry behavior, maximum work per run, atomic release path, and observability. Cloudflare compilation is not proof that a real D1 Cron run is safe.
   - Validate against an isolated D1 database before enabling the Cron Trigger.

### CARE / booking

- **PR #68** adds extra-proposal payload validation and finding ownership checks.
- **PR #72** explicitly depends on PR #68 and should be reviewed/merged after #68.
- **PR #70** adds atomic customer approval/rejection but is based on `main`, not PR #68. Reconcile its validation and ownership assumptions with #68/#72 before merging; do not assume the PR titles imply a safe order.
- **PR #69** secures and atomically assigns service requests. Review it against the current request/technician state machine and the CARE proposal flow before merging.

### Finance documentation

- PR #74: monetary-unit contract audit.
- PR #76: monetary data provenance and seed-risk inventory.
- PR #77: API money-flow and validation-boundary audit.
- These are documentation-only Draft PRs. Review their conclusions against the current source and keep their unresolved provenance/seed findings as release gates; they do not themselves change data or runtime behavior.

## Current code-level safeguards in PR #78

- No legacy wallet escrow repair/release while wallet currency provenance is unverified; wallet, transaction, and withdrawal monetary values are redacted in that state.
- Prepay fees must be safe integer IRR; the 10% commission uses the canonical explicit half-up rule.
- New withdrawals require bank transfer, a bank name, and a valid normalized Iranian Sheba. Unsupported card/wallet/cash destinations are rejected before funds are reserved.
- Admin approval requires a valid bank destination; PAID additionally requires a real external bank transfer reference.
- D1 withdrawal and admin settlement batches abort if a required mutation does not change exactly one row; SQLite integration tests exercise rollback paths. Repeated escrow release is idempotent: a previously committed release is distinguished from a failed partial write.
- VIP activation requires a successful IRR payment linked to the exact VERIFIED gateway attempt with purpose `vip`; atomic replacement plus partial unique indexes enforce one ACTIVE subscription per user.
- Unsupported FLEET_MANAGER/PARTNER job access fails closed until a real ownership relation exists; customer estimate approval cannot also transition the job to COMPLETED.
- Platform dashboard business intelligence is ADMIN-only.

These are source-level changes; the exact PR #78 head above has completed all five CI workflows. The PostgreSQL pipeline confirms 724 passing tests across 61 files, including D1-style SQLite atomicity/idempotency cases and PostgreSQL integration.

## External integration and infrastructure status

The following are intentionally deferred until near release, as requested:

- Production hosting/VPS, domain, DNS, TLS certificates, production database provisioning, and deployment.
- Real SMS provider credentials and controlled-phone delivery test.
- Real payment provider credentials and sandbox/live checkout activation.
- Production monitoring, alert routing, backup schedule, and restore rehearsal on the chosen production database.

Do not activate any of these early. Do not mistake adapter code, a successful build, or a provider status response for a real successful payment or SMS delivery.

## D1 / database validation still required

- The repository now contains SQLite-backed integration tests for D1-style atomic withdrawal creation, rejection/refund, payout settlement, and VIP subscription replacement.
- PostgreSQL CI separately validates migrations, build, backup/restore, and transaction behavior.
- **Still required before production:** run the complete migrations and concurrency/rollback suite against an isolated real Cloudflare D1 database using the actual Worker binding and production-equivalent schema. Cloudflare Build alone does not exercise D1 runtime semantics.
- Run the scheduled escrow Worker against an isolated D1 dataset, including a permanently failing early row, pagination, cursor persistence, retry, and duplicate-release scenarios.

## Production readiness contract

In production, `GET /api/ready` must return HTTP 503 until:
- a real SMS provider is selected and all required credentials are present;
- a real payment provider is configured and production checkout/callback/verification routes are wired;
- the database is reachable and is not a local file: SQLite database.

`GET /api/health` provider status is diagnostic only; it does not prove a live transaction or SMS delivery succeeded.

## Required Go / No-Go evidence

- Dependency PRs reconciled and reviewed; PR #75 merged before PR #78, and CARE PR dependencies reconciled.
- All five required workflows green on the final main commit after merges: CI, PostgreSQL CI, Production Readiness, Docker E2E, Cloudflare Build.
- Isolated real-D1 migration, transaction, concurrency, rollback, and Cron-worker tests pass.
- A real SMS delivery test succeeds on a controlled Iranian phone.
- A payment sandbox round-trip succeeds, including callback verification, exact amount/currency/purpose binding, duplicate callbacks, idempotency, refund/reconciliation, and failure recovery.
- Production backups, restore rehearsal, monitoring/alerts, domain/TLS, rollback plan, and operator runbook are verified.
- Explicit owner Go/No-Go approval.

Until every required item is evidenced, the release remains **BLOCKED / NOT PRODUCTION-READY**.
