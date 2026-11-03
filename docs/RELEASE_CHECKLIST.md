# MEKANIX — Release Checklist

**Status date:** 2026-11-03  
**Current main:** `2f3b5b750377f07657cc7db853b12338a8cfaa4a`  
**Release decision:** <strong>NO-GO</strong> — code hardening and release evidence remain incomplete.

This replaces the historical checklist snapshots from October. Do not use old “Release Candidate — all checks passed” or old staging/load-test claims as current release evidence.

## 1. Work to finish now — no production services required

### Code and business flows
- [x] Merge PR #67 — bind VIP activation to the exact verified VIP payment record.
- [x] Merge PR #68 — validate CARE extra-cost values and Finding ownership.
- [x] Merge PR #69 — secure and atomically assign service requests.
- [x] Merge PR #70 — make CARE approval/rejection transitions atomic.
- [x] Merge PR #79 — atomically create CARE extra proposals on current main.
- [ ] PR #65 — complete escrow release worker validation; all five CI workflows must pass on the latest head and isolated D1 staging evidence must be recorded before merge.
- [x] PR #80 — merged after all five workflows passed; invoice issuance is idempotent, tax/pricing inputs are validated, and DRAFT→SENT is compare-and-set.
- [ ] PR #66 — finish provider adapter review; keep live providers disabled until the authoritative payment lifecycle is wired.
- [ ] Consolidate PRs #71/#73 only after resolving the monetary-unit contract in issue #81.
- [ ] Complete the authoritative payment attempt → provider verification → invoice/VIP/prepay fulfillment lifecycle in issue #24.\n- [ ] Add the missing invoice-settlement → commission → technician pending-wallet credit → RELEASE ledger flow; invoice payment currently does not create technician earnings.
- [ ] Add invoice settlement → commission → technician pending-wallet credit → RELEASE ledger flow. Current invoice simulator does not create technician earnings.
- [ ] Resolve canonical currency, precision, rounding, FX snapshot, and payout settlement rules in issue #81.
- [ ] Complete invoice, wallet, withdrawal, payout, and callback replay/concurrency tests across SQLite/D1 and PostgreSQL.
- [ ] Complete end-to-end customer, technician, admin, CARE, warranty, refund/recovery, and notification scenarios.
- [ ] Complete final authorization/IDOR/BOLA review for every write route and admin action.
- [ ] Run performance/load tests and security scanning against a release-candidate build; record exact commit and reports.
- [ ] Verify backup creation, restore, integrity, and rollback procedure in an isolated environment.
- [ ] Reconcile environment variable schema, production Docker/Worker build, health/readiness, logging, monitoring, and operational runbooks.
- [ ] Produce a Release Candidate with all required CI checks green on the exact same commit.

### Current financial blockers
- [ ] Issue #24 — real provider lifecycle is not wired; current invoice/gateway/prepay routes are simulator-only and production-disabled.
- [ ] Issue #81 — stored monetary units, currency metadata, Persian formatting, FX rate source, and bank payout units disagree.
- [ ] Technician invoice earnings are not yet credited to the wallet through a complete idempotent escrow/commission flow.
- [ ] Do not activate live payment, wallet top-up, withdrawal, or bank payout until these are resolved.

## 2. Activate shortly before launch — deliberately deferred

- [ ] Provision production VPS/hosting and configure deployment access.
- [ ] Purchase/connect production domain; configure DNS and HTTPS/TLS.
- [ ] Provision production database and Redis only after migration/backup review.
- [ ] Add production secrets through the host's secret manager (never commit them).
- [ ] Configure live SMS provider credentials and delivery templates.
- [ ] Configure Zarinpal/IDPay merchant credentials only after sandbox certification and payment lifecycle approval.
- [ ] Configure maps/geocoding credentials and validate quota/security restrictions.
- [ ] Configure production monitoring, error alerts, log retention, backup schedule, and restore ownership.
- [ ] Apply reviewed production migrations only after a fresh backup and verified rollback plan.
- [ ] Run production smoke tests with test accounts and zero-value/non-settling checks where supported.
- [ ] Verify OTP delivery, provider callback signatures, amount/order binding, idempotency, invoice settlement, wallet ledger, and payout reconciliation.
- [ ] Run business-owner Go/No-Go review and authorize public launch explicitly.

## 3. Go / No-Go criteria

**GO only when all are true:**
- [ ] All five required workflows pass on the exact Release Candidate commit.
- [ ] No open critical/high security or financial-integrity blocker.
- [ ] SQLite/D1 and PostgreSQL migration/build/integration checks pass.
- [ ] D1 escrow worker has isolated staging evidence, safe retry proof, and no duplicate RELEASE ledger rows.
- [ ] Payment and currency contract is approved, sandbox-certified, and replay/concurrency tested.
- [ ] Invoice-to-technician-wallet settlement and payout reconciliation are proven end-to-end.
- [ ] Backup restore and rollback are rehearsed and documented.
- [ ] Production SMS, domain/TLS, hosting, monitoring, and secrets are configured and smoke-tested.
- [ ] Business owner signs off on final Persian UX and end-to-end workflows.

**Automatic NO-GO:** any unknown money unit, simulator reachable in production, missing ledger proof, non-idempotent callback, unverified payout, failed restore, or required workflow not green.

## 4. Rollback readiness

- [ ] Previous application image/Worker version and deployment configuration are retained.
- [ ] Database backup is verified and restorable.
- [ ] Migration rollback/forward-fix plan is written for every production schema change.
- [ ] DNS/TLS rollback and provider credential revocation steps are documented.
- [ ] Incident owner and escalation contacts are assigned.
- [ ] No irreversible migration or live money movement without explicit approval.

## 5. Release evidence record

For each completed gate, record:
- exact commit SHA;
- workflow/run URL and result;
- environment used (local, CI, isolated staging, production);
- test data and expected/actual result;
- backup/restore reference where applicable;
- reviewer and date.

A green PR check is not a deployment. A staging test is not a production test. Do not conflate them.
