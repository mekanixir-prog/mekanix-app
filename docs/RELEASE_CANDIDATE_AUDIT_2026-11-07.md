# MEKANIX — Release Candidate Audit (2026-11-07)

**Decision: NO-GO for public production release.**  
**Repository:** `mekanixir-prog/mekanix-app`  
**Candidate PR:** [#137 — feat(pricing): add editable versioned IRR rate card](https://github.com/mekanixir-prog/mekanix-app/pull/137)  
**Candidate branch:** `feat/admin-editable-irr-rate-card`  
**Exact code-tree SHA with all seven required workflows green:** `0b6b319b040031f4d68d0dcda2965a3fd0cb39bd`  
**PR synchronization merge commit:** `a00017bc86896630e26f39045da8bf8d3b50b703` (same tree as the validated code candidate; branch now has zero commits behind `main`).  
**Main branch SHA observed:** `10080473dd6b87ec725a5c6c22803f5d5d872342`

This is a code/repository review, not evidence of a live deployment. No production host, domain, DNS/TLS, remote D1 database, SMS provider, payment gateway, production secret, or production data was activated or changed.

## 1. What is implemented in PR #137

- Central editable rate card with separate fixed-fee schedules for supported foreign passenger vehicles and heavy machinery.
- Persian admin editor at `/admin-panel/pricing`, authenticated API, optimistic version checks, version history, validation, and audit logging.
- Integer IRR as the persisted unit; admin tariff input and display in Toman (10 IRR = 1 Toman).
- Separate dispatch, inspection, extra-distance, fixed labor, and emergency fee components.
- Emergency surcharge is calculated on fixed labor only.
- CARE booking and repair invoice pricing use the same rate-card calculation engine.
- CARE snapshots persist inspection and emergency amounts; invoice records persist inspection and emergency line items.
- Customer CARE preview uses an authenticated, owner-scoped server quote endpoint. The quote version is pinned into booking submission; a changed rate card returns HTTP 409 for a fresh customer review.
- Unsupported vehicle/service classifications fail closed. Ambiguous engine categories require explicit minor/major mapping.
- Fixed labor is presented as a service unit, not as hourly labor.
- Unapproved six-month warranty claims and the VIP extended-warranty benefit copy were removed from the reviewed customer-facing language. VIP copy is limited to periodic visits; repairs and parts remain excluded.
- Production price calculation remains disabled until explicit owner approval via `MEKANIX_PRICING_IRR_APPROVED=true`; even if the flag is set, production fails closed when no persisted rate-card record exists and never silently falls back to illustrative in-code defaults.

## 2. CI evidence

All seven required PR workflows completed successfully on exact code-tree commit `0b6b319b040031f4d68d0dcda2965a3fd0cb39bd` (short SHA `0b6b319`). The feature branch was then synchronized with the current `main` using merge commit `a00017bc86896630e26f39045da8bf8d3b50b703`; its Git tree is identical to the validated code tree. On that synchronization commit, six workflows have completed successfully and Docker E2E is re-running; Docker E2E also passed on the identical code tree at run `42337312577`.

| Workflow / check | Run ID | Result on validated code tree |
|---|---:|---|
| CI — Lint + TypeCheck + Test | 42337312580 | success |
| Production readiness | 42337312597 | success |
| Docker E2E — Compose + Health | 42337312577 | success |
| PostgreSQL CI — Migration + Build | 42337312576 | success |
| Cloudflare Build — OpenNext → Cloudflare Worker | 42337312578 | success |
| CodeQL Security Analysis | 42337312604 | success |
| Secret Scan | 42337312573 | success |

Additional exact-code-tree evidence:
- Prisma Client generation, repository hygiene, ESLint, TypeScript, unit/integration tests, and security audit passed.
- PostgreSQL migrations deployed; isolated backup/restore rehearsal and encrypted-backup/safe-restore checks passed; TypeScript, tests, and production build passed.
- Docker Compose build and health checks passed, PostgreSQL backend verification passed, and production OTP correctly failed closed without a real SMS provider.
- Cloudflare Worker build, local D1 scheduled escrow-release test, and artifact verification passed.
- The new admin rate-card compare-and-set regression test and required CARE quote-version schema tests passed in CI.
- None of these checks deploys the application or verifies live external providers.

Exact validated code-tree checks: https://github.com/mekanixir-prog/mekanix-app/commit/0b6b319b040031f4d68d0dcda2965a3fd0cb39bd/checks  
Current PR head: https://github.com/mekanixir-prog/mekanix-app/pull/137


## 3. Financial proposal — owner approval still required

The editable baseline is a proposal, not an approved tariff. Passenger dispatch/inspection values were compared with a September 1405 Sanjagh listing; this is a market reference, not an official tariff. Heavy-equipment rates are internal estimates and still require sampling with technicians and suppliers in the actual service regions.

The proposal includes:
- Passenger base dispatch 500,000 Toman; inspection 600,000 Toman; 10 km included; additional distance 10,000 Toman/km.
- Heavy base dispatch 2,000,000 Toman; inspection 2,000,000 Toman; 10 km included; additional distance 30,000 Toman/km.
- Fixed labor schedules by service code; parts quoted separately.
- Emergency surcharge 30% of fixed labor only.
- Tax and commission disabled.
- VIP disabled; proposed annual plan covers four periodic visits only, not repairs or parts.
- Manual discount cap is a stored policy setting only; no invoice discount is applied until authorization/audit flow exists.

No value in this proposal should be activated in production until the owner signs off on the exact passenger and heavy-equipment values, scope, region policy, and effective date.

## 4. Additional concurrency hardening completed

- Admin rate-card updates now compare-and-set against the exact PlatformSetting row read at the beginning of the request. A second read after audit persistence is no longer allowed to replace the original CAS predicate; concurrent changes return HTTP 409. A regression test covers this race.
- CARE booking now requires `expectedPricingVersion`; requests without the server-quoted version are rejected, and a changed rate-card version returns HTTP 409.
- The feature branch is synchronized with `main` (zero commits behind); the synchronization merge commit preserves the already-tested feature tree.

## 5. Technical risks still requiring closure

1. **Extra-distance method:** the current invoice calculation estimates road distance as Haversine straight-line distance × 1.3, rounded up. This is not a navigation-provider route. Obtain explicit approval for this estimation policy or replace it with a verified routing provider before extra-kilometre billing is enabled.
2. **Legacy financial provenance:** old technician fees, job-part prices, wallet/invoice values, and withdrawals still require record-level reconciliation. Do not infer old units or mass-convert historical rows.
3. **Payment and settlement:** provider initiation/verification, signed callbacks, replay/idempotency, refunds/reconciliation, invoice settlement, technician wallet credit, escrow release, and payout proof remain separate release blockers.
4. **Tax/commission/VIP:** no production tax, commission settlement, or VIP sale is enabled. Their policy and end-to-end lifecycle require separate approval and implementation.
5. **Staging evidence:** CI does not prove a live Cloudflare Worker, remote D1 schema, Cron execution, real SMS delivery, or sandbox payment round-trip.
6. **Warranty terms:** any warranty duration, coverage, exclusions, and claims workflow must be owner-approved and recorded in the actual service agreement. Do not restore a six-month or twelve-month promise based on old copy.
7. **Customer-facing price read paths:** PR #137 updates the CARE booking quote. A separate audit must still verify every other wallet, invoice, package, and legacy financial read path before live financial display is enabled.

## 6. Repository governance

GitHub currently reports:
- `main` branch `protected=false`;
- the existing repository ruleset named `main` has `enforcement=disabled`;
- no required status checks are enforced by branch protection.

Enable the ruleset and configure required checks before relying on PR gating. Match required checks to actual workflow triggers; do not require path-filtered checks on PRs that cannot trigger them. Avoid requiring a second approval if no second maintainer exists unless a deliberate administrator bypass is configured.

## 7. Release sequence

### Complete before merge
- [x] All seven required workflows pass on exact candidate SHA `9f2326ec9234eb1f05806f4710232d489473535b`; any further code or documentation edit requires a fresh exact-head check run.
- [ ] Review the full PR diff and SQLite/D1 plus PostgreSQL migration tracks.
- [ ] Review the CARE quote endpoint, quote-version conflict behavior, and customer-facing Toman display.
- [ ] Approve the actual tariff values and the extra-distance calculation method.
- [ ] Enable repository branch governance and required checks.
- [ ] Review any remaining critical/high security or financial-integrity findings.

### Complete in isolated staging
- [ ] Deploy a preview Worker and isolated D1 database; apply migrations only after backup and preflight.
- [ ] Verify `/api/health` and `/api/ready`; readiness must fail closed while required gates are incomplete.
- [ ] Exercise OTP, ownership/IDOR boundaries, customer CARE booking, technician mission updates, invoice creation, admin pricing edit, and quote-version conflicts.
- [ ] Validate D1 and PostgreSQL migration behavior, idempotency, partial failures, and concurrency.
- [ ] Test real SMS provider delivery using authorized test numbers.
- [ ] Test payment sandbox signatures, amount/currency binding, duplicate/replayed/out-of-order callbacks, refund/reconciliation, and settlement.
- [ ] Perform a backup restore and Worker rollback rehearsal; record evidence and operators.

### Activate shortly before public launch
- [ ] Provision production hosting/Worker and production database after provider choice.
- [ ] Configure domain, DNS, HTTPS/TLS, canonical redirects, cookies, and security headers.
- [ ] Add production secrets through secret storage; never commit or paste them into issues.
- [ ] Configure real SMS and payment credentials only after sandbox certification.
- [ ] Verify maps/routing provider and the extra-distance policy.
- [ ] Configure monitoring, alerts, log retention, backup schedule, incident ownership, and emergency contacts.
- [ ] Apply approved production migrations after fresh backup and verified recovery path.
- [ ] Run real-domain smoke tests and obtain explicit owner Go/No-Go approval.

## 8. Safety decision

PR #137 may be reviewed as a bounded code change, but **it is not a production release approval**. Keep production pricing approval unset, keep payment/VIP/tax/commission disabled, and do not deploy public traffic until all gates above have evidence and the owner explicitly approves launch.

 
## 8. Follow-up code review — 2026-11-07

**Reviewed head:** `33d462502bb609e92cf3e2734e733a9ccf65e663` (PR #137 remains Draft). This section supersedes earlier unchecked findings where stated below; it does not change the overall **NO-GO** decision.

### Fixed after the initial audit

- The pricing engine now requires an explicit `serviceCode`; no implicit diagnostic fallback remains.
- Customer approval is Boolean-only, role-restricted, and cannot be combined with status jumps. The job-status route and Prisma/D1 atomic writer enforce the approval boundary.
- The estimate lifecycle is guarded: pre-estimate preparation and part entry happen before invoice issuance; a verified IRR estimate must exist before customer approval; actual repair and completion require stored customer consent. The technician UI distinguishes estimate preparation from post-approval repair.
- Session and OTP verification responses share a fail-closed technician-fee masking helper.
- Service-request schema requires a registered `vehicleId`; atomic D1 insertion rechecks vehicle ownership and supported scope to close the lookup/write race.
- Regression tests cover the new state-machine, D1 race, schema, and financial-mask cases.

### Financial read-path cross-check

Current candidate projections were checked in:
- technician public list/detail;
- auth session and OTP verification;
- job list/detail;
- invoice list/detail and invoice mutations;
- wallet and withdrawal read/status;
- prepay and prepay status;
- VIP plan/subscription;
- CARE booking list/detail and pricing snapshot.

This is a code review of the candidate tree, not evidence of a live production data migration or provider integration.

### PR #136 overlap

PR #136 is Draft and diverged from `main` (160 ahead, 2 behind). All 76 of its changed files are also changed by PR #137; 47 file blobs are identical and 29 differ. PR #137 contains the newer integrated versions. A review comment (ID `5810569703`) advises against merging PR #136 independently. Keep it open only until any unique changes are confirmed, then close it as superseded.

### Workflow results on the reviewed head

- CI: success — run `42347387500`
- Production readiness: success — run `42347387395`
- PostgreSQL CI: success — run `42347387562`
- Cloudflare Build: success — run `42347387614`
- CodeQL: success — run `42347387448`
- Secret Scan: success — run `42347387466`
- Docker E2E: in progress — run `42347387459`

The candidate must be revalidated on the exact final head after any subsequent edit. The ruleset for `main` remains disabled and has no required status checks. Production credentials and external services remain intentionally inactive.



## Follow-up audit — 2026-11-09 (supersedes earlier proposal and scope findings)

The overall release decision remains **NO-GO for public production**. This section is the current follow-up to the historical 2026-11-07 snapshot above; exact-head CI evidence must always be read from PR #137, not copied from an older audit section.

### Confirmed product-owner decision

- Issue #99 records the product owner's approval on 2026-11-04 of the initial editable fixed-fee baseline listed in `docs/PRICING_RATE_CARD.md`.
- The earlier statement that the entire initial rate card still awaits owner approval is superseded.
- Heavy-equipment figures remain internal initial estimates pending regional technician/supplier sampling. This is a calibration task, not a reason to infer different rates.
- Tax, platform commission/settlement, VIP sales/refunds, technician escrow/release, and withdrawal policy remain separate approval and implementation gates.
- The Haversine × 1.3 extra-distance method has **not** been approved. Production extra-kilometre billing is now fail-closed behind `MEKANIX_EXTRA_DISTANCE_IRR_APPROVED=true`; absent that separate approval, only base dispatch is billed.

### Current candidate hardening

- Ambiguous `OTHER` and unknown asset types now fail closed at the pricing, vehicle registration/update, CARE booking, and service-request boundaries. The Prisma helper and D1 INSERT predicate use the same supported allowlist; a D1 preflight/write-race integration test covers an asset changing to `OTHER`.
- Successful bank payout settlement now writes a zero-delta `PAYOUT` WalletLedger audit event in the same Prisma transaction or D1 batch as the paid-state transition, payout transaction, and wallet aggregate update. It does not debit the spendable balance a second time. Tests cover the event and rollback when the audit write fails.
- Production pricing separately gates extra-distance charges; the invoice estimate text distinguishes base dispatch from extra-kilometre charges when that policy is disabled.
- The current candidate branch includes the shared role-transition matrix at the atomic database boundary. Do not merge the older PR #138 branch wholesale; it was based on a stale predecessor. Its remaining useful changes were selectively ported to the current PR #137 branch.

### Payment work remains limited

- PRs #139–#146 are a dependent draft stack built on the older PR #138 branch. Their exact-head CI runs passed for the reviewed snapshots, but they have not been rebased onto the current PR #137 candidate.
- The outbox worker in PR #143 is scoped to the **VIP simulator** event only. It is not a live Zarinpal integration and does not complete invoice/prepay payment, signed provider callbacks, refunds, commission, technician earnings, escrow release, or payout reconciliation.
- PR #148 adds Zarinpal sandbox adapter contract tests only. It does not activate a real merchant account or production payment route.
- No real provider credential, SMS credential, live payment, or production deployment is enabled. The owner has scheduled real Zarinpal/SMS credentials for approximately T-1 before public launch; engineering contracts, mock tests, and runbooks should be ready beforehand.

### Remaining NO-GO gates

1. Reconcile legacy money provenance record by record under integer IRR storage and Toman-only display. Quarantine unknown historical values; no bulk conversion or unit inference.
2. Complete the authoritative persisted payment-attempt lifecycle for invoice, VIP, and prepay, including server-derived amount/currency/owner binding, provider verification, signed callback/replay protection, purpose-specific exactly-once fulfillment, retryable outbox/recovery, refund and reconciliation.
3. Complete invoice settlement → commission policy → technician pending earnings → escrow hold/release → withdrawal → bank payout reconciliation. The new payout audit event is only one accounting control, not end-to-end settlement.
4. Approve tax treatment, commission base/rate, technician net/gross and escrow timing, VIP renewal/refund terms, and withdrawal limits/fees.
5. Complete isolated remote staging: remote D1 migrations/binding, Cron execution, backup/restore, rollback, monitoring/alerts, business E2E, and controlled SMS/payment sandbox smoke tests.
6. Enable the existing `main` repository ruleset and required checks. Enforcement was disabled in the latest repository audit; do not rely on CI gating until the owner enables governance.
7. Complete the independent full-diff review and final security/authorization/IDOR review against one exact Release Candidate SHA.

Any code or documentation edit requires fresh workflow evidence on the exact final PR head. Keep the candidate Draft and do not merge or deploy solely because prior workflows passed.
