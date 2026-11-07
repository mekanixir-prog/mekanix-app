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

## 4. Additional concurrency hardening completed\n\n- Admin rate-card updates now compare-and-set against the exact PlatformSetting row read at the beginning of the request. A second read after audit persistence is no longer allowed to replace the original CAS predicate; concurrent changes return HTTP 409. A regression test covers this race.\n- CARE booking now requires `expectedPricingVersion`; requests without the server-quoted version are rejected, and a changed rate-card version returns HTTP 409.\n- The feature branch is synchronized with `main` (zero commits behind); the synchronization merge commit preserves the already-tested feature tree.\n\n## 5. Technical risks still requiring closure

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
