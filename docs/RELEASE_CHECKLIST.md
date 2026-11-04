# MEKANIX — Release Checklist

**Status date:** 2026-11-04  
**Current main baseline:** `db0f3361c3158764c47cfeb48d5b9dafadc90610`  
**Release decision:** <strong>NO-GO</strong> — code hardening and release evidence remain incomplete.

This replaces the historical checklist snapshots from October. Do not use old “Release Candidate — all checks passed” or old staging/load-test claims as current release evidence.

## 1. Work to finish now — no production services required

### Code and business flows
- [x] Merge PR #67 — bind VIP activation to the exact verified VIP payment record.
- [x] Merge PR #68 — validate CARE extra-cost values and Finding ownership.
- [x] Merge PR #69 — secure and atomically assign service requests.
- [x] Merge PR #70 — make CARE approval/rejection transitions atomic.
- [x] Merge PR #79 — atomically create CARE extra proposals on current main.
- [x] PR #65 — escrow release worker validation merged as `97d50eb000e39e087eaea6403b23f9fe262b9d76`. The CI/local D1 scheduled-event test passed on its reviewed head. Remote Cloudflare D1 staging and Cron observation remain pre-launch gates before enabling the production schedule.
- [x] PR #80 — merged after all five workflows passed; invoice issuance is idempotent, tax/pricing inputs are validated, and DRAFT→SENT is compare-and-set.
- [x] PR #66 — provider adapter hardening merged as `36b05650d011b60ace35f0751921c941de3f24a1`. All five required workflows passed on exact PR head `f320fd726fcbcc12add6ae8d2cbca14dccf4dbad`; post-merge CI on the merge commit is being revalidated. Adapters remain sandbox-only and disconnected from production payment routes.
- [ ] Consolidate PRs #71/#73 only after resolving the monetary-unit contract in issue #81.
- [ ] Complete the authoritative payment attempt → provider verification → invoice/VIP/prepay fulfillment lifecycle in issue #24.
- [ ] Add invoice settlement → commission → technician pending-wallet credit → RELEASE ledger flow. Current invoice simulator does not create technician earnings.
- [x] Owner approved canonical integer IRR storage and Toman-only display conversion (10 IRR = 1 Toman); decision recorded in issue #81.
- [x] PR #75 — merged integer-IRR validation, safe arithmetic, explicit ratio rounding, and signed ledger-delta helpers as `38cd3db63bc5c0389f608a3541146c5bdc43ec9b`. These primitives are not yet wired through legacy records or the complete payment/settlement lifecycle.
- [x] PR #101 — merged non-destructive demo-seed protections as `5c191f7efdea278611a9a65f39d481072ed37189`; all five required PR workflows passed on the exact reviewed head. Subsequent full main-branch CI passed on `abf7f849c70d90580f08aa84a74fc7f93d1b9acf`.
- [x] PR #103 — merged `formatTomanFromIrr` as `406f72b9c726e4d305ccfffc11ca9f6f01c5d50d`; exact 10:1 IRR→Toman presentation, signed values, locale-aware digits/separators, and validation tests. Helper-only; no legacy data conversion or UI call-site rollout.
- [ ] Reconcile historical money-unit provenance, approve integer/rounding bounds and commercial pricing, and implement the safe migration plan in issue #81.
- [ ] Complete invoice, wallet, withdrawal, payout, and callback replay/concurrency tests across SQLite/D1 and PostgreSQL.
- [ ] Complete end-to-end customer, technician, admin, CARE, warranty, refund/recovery, and notification scenarios.
- [ ] Complete final authorization/IDOR/BOLA review for every write route and admin action.
- [ ] Run performance/load tests and security scanning against a release-candidate build; record exact commit and reports.
- [ ] Verify backup creation, restore, integrity, and rollback procedure in an isolated environment.
- [ ] Reconcile environment variable schema, production Docker/Worker build, health/readiness, logging, monitoring, and operational runbooks.
- [ ] Produce a Release Candidate with all required CI checks green on the exact same commit.

### Recently merged security work

- PR #90: `802e91de00c148c7d7981a68702fe873e181ace9`.
- PR #92: `135db9a0ea9a57ea4fe2c5d5662adf1e5260cde6`.
- PR #94: `8bab4c9e3dfc99cb07323d432c6b9ce0076130a3`.
- PR #95: `7eb870bb6e494c6973d17a64b55f28d11c7eba0e`.
- PR #98: `5c3f2789ababbde68543d86934996636f5726fe7`.
- PR #101: `5c191f7efdea278611a9a65f39d481072ed37189` — demo seed and auto-seed safety.
- PR #103: `406f72b9c726e4d305ccfffc11ca9f6f01c5d50d` — verified-IRR Toman presentation helper.

### Current financial blockers
- [ ] Issue #24 — real provider lifecycle is not wired; current invoice/gateway/prepay routes are simulator-only and production-disabled.
- [ ] Issue #81 — canonical unit is approved (integer IRR; Toman display only), but legacy row provenance, mixed-unit seed values, formatting by record provenance, and payout reconciliation remain unresolved.
- [ ] Issue #99 — commercial pricing/settlement schedule is not owner-approved: labor/visit/travel rates, emergency multiplier, tax, vehicle multipliers, commission, VIP prices, and withdrawal minimums must be explicitly decided before activation. Existing code/seed values are not approved business policy.
- [ ] Technician invoice earnings are not yet credited to the wallet through a complete idempotent escrow/commission flow.
- [ ] Do not activate live payment, wallet top-up, withdrawal, or bank payout until these are resolved.

### Completed security remediations — deployment follow-through remains

- [x] PR #90 — standalone admin JWT replaced with revocable HttpOnly cookie session; same-origin protections added; dedicated admin bearer tokens are no longer returned or accepted.
- [x] PR #92 — unsupported job participant roles denied before job lookup; CUSTOMER/TECHNICIAN ownership and assignment rules covered by regression tests.
- [x] PR #94 — unrestricted related User includes replaced with explicit safe projections; legacy password/session/OTP fields are omitted.
- [x] PR #95 — platform-wide financial and technician analytics restricted to ADMIN before database queries.
- [x] PR #98 — top-level User responses in OTP verification, mechanic approval, and development demo use explicit credential-free projections.
- [ ] Apply the SQLite/D1 and PostgreSQL `AdminUser.sessionVersion` migrations before deploying the updated admin panel.
- [ ] Verify standalone admin login/logout and onboarding protections in an isolated staging environment; confirm the OTP-based in-app AdminApp path remains functional.
- [ ] Confirm existing standalone admin users sign in again after deployment; old LocalStorage bearer tokens are intentionally not accepted.

## 2. Activate shortly before launch — deliberately deferred

- [ ] Provision production VPS/hosting and configure deployment access.
- [ ] Purchase/connect production domain; configure DNS and HTTPS/TLS.
- [ ] Provision production database and Redis only after migration/backup review.
- [ ] Add production secrets through the host's secret manager (never commit them).
- [ ] Configure live SMS provider credentials and delivery templates.
- [ ] Configure Zarinpal/IDPay merchant credentials only after sandbox certification and payment lifecycle approval.
- [ ] Configure maps/geocoding credentials and validate quota/security restrictions.
- [ ] Deploy the escrow Worker to isolated remote D1 staging; verify its binding and Cron Trigger, observe scheduled release/replay behavior, and reconcile wallet/ledger state while keeping the production schedule disabled.
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
- [ ] D1 escrow worker passes the local D1 scheduled-event integration test, and remote staging/Cron evidence is recorded before production enablement.
- [ ] Payment lifecycle is complete, sandbox-certified, and replay/concurrency tested against the approved integer-IRR contract.
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

## 6. Mainline delta — 2026-11-04

This section records changes after the previous 2026-11-03 checklist snapshot. The detailed current audit is `RELEASE_READINESS_AUDIT_2026-11-04.md`.

### Verified on current main

- [x] PR #112 — historical withdrawal approval/rejection/payout actions now fail closed until withdrawal-record IRR provenance is explicitly verified. Merged as `ad1f6af246369bfc071a28dc68589c3f6a0d1331`.
- [x] PR #120 — production readiness requires strong user/admin/OTP secrets, shared rate-limit storage, admin provisioning, IRR pricing/provenance, withdrawal policy/provenance, and escrow-worker readiness. Merged as `2bf40e8642019550b2710bb171f2fd5ebe4116e8`.
- [x] All eight active main-branch workflows passed on exact baselines `2bf40e8642019550b2710bb171f2fd5ebe4116e8` and `e03f84da91db464edd2ca6ae32fdd156174c948b`; the newest baseline `dae8fe53bf8c5c776ed939d665a8a146619162db` is undergoing its fresh full workflow run.

### Security PR reconciliation

- [x] PR #113 — same-origin admin CSRF defense-in-depth reviewed and squash-merged as `e03f84da91db464edd2ca6ae32fdd156174c948b`; all eight active main workflows passed on that exact commit.
- [x] PR #115 — closed as superseded: current main already checks the related User's status and role in the Session query and rejects a missing related User. The dedicated deleted-user regression test has not yet been added.
- [x] PR #116 — closed as superseded: current main already uses canonicalized keyed-HMAC per-phone OTP throttling at 5 attempts per 10 minutes; PR #127 adds the missing unavailable-store 503 test.
- [x] PR #127 — shared per-phone OTP verification limiter unavailable-store (503) regression test; all seven applicable checks passed and the PR merged as `147d5485ee0dfd2dc5795f6000dd38b35c808c07`.

### Withdrawal hardening

- [x] PR #129 — bank-only/valid-Sheba creation and D1 rollback guards, preserving the current integer-IRR production gate; all eight applicable PR checks passed and merged as `dae8fe53bf8c5c776ed939d665a8a146619162db`.
- [x] PR #124 — `actions/upload-artifact` v7; eight applicable PR checks passed and merged as `25e08a476cd2d975b517651a4d758e82ac51b3db`.
- [x] PR #125 — `actions/checkout` v7; eight applicable PR checks passed and merged as `8ac36ef874590150d1af6f92693b30ea41708e6a`.
- [x] PR #126 — `docker/setup-buildx-action` v4; seven applicable PR checks passed and merged as `db0f3361c3158764c47cfeb48d5b9dafadc90610`.

### Repository-level governance

- [ ] Issue #121 — enable the existing `main` ruleset. As of this audit, the ruleset exists but enforcement is disabled, main is not protected, and no required status checks or approvals are configured.
- [ ] Configure required checks to match workflow triggers. Cloudflare Build and Dependency Security Audit are path-filtered; do not require either unconditionally unless the trigger policy is changed.
- [ ] Do not require a second approval until a second maintainer is available; choose an explicit administrator bypass to avoid blocking all single-maintainer merges.

### Financial work still blocked

- [ ] Issue #24 — complete authoritative payment attempts, provider initiation/verification, callback idempotency, purpose-specific fulfillment, and invoice-to-technician ledger/escrow settlement.
- [ ] Issue #81 — classify and reconcile historical money provenance under the owner-approved integer-IRR contract. Unknown rows remain quarantined; no blanket conversion.
- [ ] Issue #130 — remove FX-based IRR formatting, mask unverified wallet/invoice reads, and enforce safe-integer IRR at writers.
- [ ] Issue #99 — approve fixed-fee labor and separate IRR rate cards for priority heavy machinery and supported foreign passenger vehicles (excluding Iran Khodro/Saipa); approve tax, commission/escrow, annual VIP price (free periodic visits only; repairs/parts excluded), CARE boundary and withdrawal policy. No illustrative 15% commission or sample prices may be treated as approved.
- [x] PRs #71/#73 are closed; useful safe work from #71 was ported to #129, while #73's USD/decimal policy was not ported. PR #78 remains a stale large branch and must be split/rebased into bounded changes before review.

### Launch infrastructure remains deliberately deferred

- [ ] VPS/hosting, production domain/DNS/HTTPS, live SMS and payment credentials remain scheduled for shortly before launch.
- [ ] Integration contracts and deployment runbooks must be ready now; isolated staging, remote D1/Cron verification, backup/restore, rollback, monitoring, real-provider smoke tests and business E2E remain mandatory before public launch.

