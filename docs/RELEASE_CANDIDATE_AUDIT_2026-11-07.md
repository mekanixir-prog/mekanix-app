# MEKANIX — Release Candidate Audit (2026-11-07)

**Decision: NO-GO for public production release.**  
**Repository:** `mekanixir-prog/mekanix-app`  
**Candidate PR:** [#137 — feat(pricing): add editable versioned IRR rate card](https://github.com/mekanixir-prog/mekanix-app/pull/137)  
**Candidate branch:** `feat/admin-editable-irr-rate-card`  
**Code candidate SHA reviewed before this audit-record update:** `3a50eff8f7d1a6f09f8ae1ca1f04579c81e254ae`  
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
- Production price calculation remains disabled until explicit owner approval via `MEKANIX_PRICING_IRR_APPROVED=true`.

## 2. CI evidence

On the prior code candidate `01b44b38651f216d4373bda69c1a3bcbaa4697f2`, all seven required PR workflows completed successfully:

| Workflow | Run ID | Result |
|---|---:|---|
| CI | 41860979640 | success |
| Production readiness | 41860980087 | success |
| Docker E2E | 41860979432 | success |
| PostgreSQL CI | 41860979655 | success |
| Cloudflare Build | 41860979781 | success |
| CodeQL Security Analysis | 41860979785 | success |
| Secret Scan | 41860980078 | success |

**Important:** the later CARE quote/UI/schema/test changes and release-documentation updates require fresh checks on the final PR head. Do not treat the seven runs above as validation of later commits. The current PR checks page is the source of truth for the latest head:
https://github.com/mekanixir-prog/mekanix-app/pull/137

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

## 4. Technical risks still requiring closure

1. **Extra-distance method:** the current invoice calculation estimates road distance as Haversine straight-line distance × 1.3, rounded up. This is not a navigation-provider route. Obtain explicit approval for this estimation policy or replace it with a verified routing provider before extra-kilometre billing is enabled.
2. **Legacy financial provenance:** old technician fees, job-part prices, wallet/invoice values, and withdrawals still require record-level reconciliation. Do not infer old units or mass-convert historical rows.
3. **Payment and settlement:** provider initiation/verification, signed callbacks, replay/idempotency, refunds/reconciliation, invoice settlement, technician wallet credit, escrow release, and payout proof remain separate release blockers.
4. **Tax/commission/VIP:** no production tax, commission settlement, or VIP sale is enabled. Their policy and end-to-end lifecycle require separate approval and implementation.
5. **Staging evidence:** CI does not prove a live Cloudflare Worker, remote D1 schema, Cron execution, real SMS delivery, or sandbox payment round-trip.
6. **Warranty terms:** any warranty duration, coverage, exclusions, and claims workflow must be owner-approved and recorded in the actual service agreement. Do not restore a six-month or twelve-month promise based on old copy.
7. **Customer-facing price read paths:** PR #137 updates the CARE booking quote. A separate audit must still verify every other wallet, invoice, package, and legacy financial read path before live financial display is enabled.

## 5. Repository governance

GitHub currently reports:
- `main` branch `protected=false`;
- the existing repository ruleset named `main` has `enforcement=disabled`;
- no required status checks are enforced by branch protection.

Enable the ruleset and configure required checks before relying on PR gating. Match required checks to actual workflow triggers; do not require path-filtered checks on PRs that cannot trigger them. Avoid requiring a second approval if no second maintainer exists unless a deliberate administrator bypass is configured.

## 6. Release sequence

### Complete before merge
- [ ] Confirm all seven workflows pass on the exact final PR head after the last code/documentation change.
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

## 7. Safety decision

PR #137 may be reviewed as a bounded code change, but **it is not a production release approval**. Keep production pricing approval unset, keep payment/VIP/tax/commission disabled, and do not deploy public traffic until all gates above have evidence and the owner explicitly approves launch.
