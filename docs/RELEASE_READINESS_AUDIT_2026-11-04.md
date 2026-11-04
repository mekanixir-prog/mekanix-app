# MEKANIX — Release Readiness Audit

**Audit date:** 2026-11-04  
**Audited branch:** `main`  
**Current main baseline:** `16aa0f43112860c2723db94a7759318e5887379e`  
**Repository:** [mekanixir-prog/mekanix-app](https://github.com/mekanixir-prog/mekanix-app)  
**Release decision:** **NO-GO** — the current mainline is CI-green, but financial integrity, release evidence, and repository governance are not complete.

This report supersedes earlier point-in-time release snapshots. It does not claim that a production deployment, live provider transaction, remote D1 staging rehearsal, or public launch has occurred.

## 1. Executive decision

The last fully green main baseline `147d5485ee0dfd2dc5795f6000dd38b35c808c07` passed all eight workflows. Withdrawal hardening PR #129 then passed all eight applicable PR checks and merged as `dae8fe53bf8c5c776ed939d665a8a146619162db`. Dependabot PRs #124, #125 and #126 then passed their applicable PR checks and merged sequentially, producing `db0f3361c3158764c47cfeb48d5b9dafadc90610`. Documentation PR #128 corrected the release evidence; formatter PR #131 then removed implicit FX conversion from the IRR display path and merged as `68201eb6fe4705c79d27abf502c895e86bacf3ba`. Job Part integer-IRR writer PR #133 then merged as `16aa0f43112860c2723db94a7759318e5887379e`, the current main baseline.

A fresh read of the GitHub Checks API for the exact current-main SHA `16aa0f43112860c2723db94a7759318e5887379e` confirms **8 successful checks and 1 skipped check**. The skipped item is `Prepare dependency remediation branch`; it is not counted as a successful workflow and is not treated as a failure. The eight successful checks are:

| Check run | Result |
|---|---|
| PostgreSQL Migration + Build | PASS |
| quality | PASS |
| OpenNext → Cloudflare Worker | PASS |
| Docker Build + Compose + Health | PASS |
| Audit the committed lockfile (no auto-fix) | PASS |
| Analyze JavaScript and TypeScript | PASS |
| Scan repository history for exposed secrets | PASS |
| Lint + TypeCheck + Test | PASS |

[Exact current-main check-run evidence](https://github.com/mekanixir-prog/mekanix-app/commit/16aa0f43112860c2723db94a7759318e5887379e/checks). Historical workflow links below refer to earlier baselines and must not be read as evidence for the current SHA.

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

- **PR #113** — cookie-authenticated admin mutations now pass through the same-origin/CSRF helper before any write. The standalone admin cookie remains scoped to `/api/admin-panel`; generic `/api/admin` routes continue to support bearer-token sessions. Seven applicable checks passed on the exact PR head; squash-merged as `e03f84da91db464edd2ca6ae32fdd156174c948b`.
- **PR #112** — historical withdrawal actions are blocked unless withdrawal IRR provenance has been explicitly verified. Merged as `ad1f6af246369bfc071a28dc68589c3f6a0d1331`.
- **PR #120** — production readiness gates now require strong secrets, shared rate-limit availability, admin provisioning, financial policy/provenance attestations, and escrow-worker readiness. Merged as `2bf40e8642019550b2710bb171f2fd5ebe4116e8`.
- **PR #127** — adds the missing HTTP 503 regression test for unavailable shared per-phone OTP verification rate-limit storage. Seven applicable checks passed on exact head `27de3d38e8bb`; merged as `147d5485ee0dfd2dc5795f6000dd38b35c808c07`.
- **PR #129** — bank-only/valid-Sheba withdrawal creation plus D1 zero-row rollback guards. Eight applicable checks passed on exact head `73140a1797f1`; merged as `dae8fe53bf8c5c776ed939d665a8a146619162db`. Existing production IRR gates were preserved.
- **PR #124** — `actions/upload-artifact` upgraded to v7; eight applicable checks passed, merged as `25e08a476cd2d975b517651a4d758e82ac51b3db`.
- **PR #125** — `actions/checkout` upgraded to v7; eight applicable checks passed, merged as `8ac36ef874590150d1af6f92693b30ea41708e6a`.
- **PR #126** — `docker/setup-buildx-action` upgraded to v4; seven applicable checks passed (Cloudflare Build was not triggered by its path filter), merged as `db0f3361c3158764c47cfeb48d5b9dafadc90610`.
- **PR #128** — corrected the 2026-11-04 release audit/checklist against exact current-main check-run evidence; seven applicable checks passed and merged as `e0c8459871d739ab12c29136636e7555a2f266ed`.
- **PR #131** — removed mutable USD FX multiplication from the shared IRR formatter and stopped Persian language selection from overriding an explicitly supplied currency; eight checks passed and merged as `68201eb6fe4705c79d27abf502c895e86bacf3ba`. Persian Toman presentation remains deferred until record-level provenance masking is implemented.
- **PR #133** — Job Part writer now rejects missing, fractional, negative, and unsafe quantity/IRR price values; all applicable CI checks passed and it merged as current main `16aa0f43112860c2723db94a7759318e5887379e`.

### Closed as superseded

- **PR #115** — current `src/lib/auth.ts` already checks the related User's status and role in the Session query and rejects a missing related User. The proposed extra `db.user.findUnique` call would duplicate the lookup. The production null check is present; a dedicated deleted-user regression test has not yet been added.
- **PR #116** — current OTP send/verify code already uses keyed HMAC phone identifiers with canonicalization and a 5-attempt / 10-minute per-phone verification budget, in addition to the IP budget. The old PR's unkeyed SHA-256 key and 10-attempt / 5-minute policy were weaker; the only missing 503 unavailable-store test was added separately in PR #127.
- **PRs #71 and #73** — closed. Useful bank-only and D1 rollback work from #71 was ported to current-mainline PR #129. #73's USD minimum/maximum and cent precision conflicted with the approved integer-IRR contract and were not ported.

### Still open

- **PR #78** — broad 80-file financial branch, stacked on the old `feat/irr-money-core` branch. It is 260 commits ahead and 144 behind current `main`; do not merge wholesale. It also writes `currency: "IRR"` to `Part` while its own `prisma/schema.prisma` still has no `Part.currency` field and the schema is not changed in the PR. Extract and re-review small, current-mainline changes by bounded financial flow after the data and commercial contracts are settled.


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

Implementation tracking: [Issue #130](https://github.com/mekanixir-prog/mekanix-app/issues/130) tracks the code-level display, read-masking and writer-boundary fixes described below.

### Current-main display and read-path findings

A current-main source trace adds four concrete tasks to the provenance work:

- **Resolved by PR #131:** `src/lib/format.ts::fmtMoney` no longer multiplies IRR amounts by mutable USD FX, and `useT().money` no longer forces the currency to IRR solely because the language is Persian. Explicit USD values remain USD. The current interim Persian display is raw IRR; exact Toman presentation is deliberately deferred until read-side provenance masking prevents unknown historical amounts from being presented as verified IRR.
- `GET /api/wallets` returns wallet balances, transactions and withdrawals without read-side provenance masking.
- `GET /api/invoices` returns existing invoice/payment records without applying the write-side price-provenance gate. The POST writer is gated, but that does not classify legacy records.
- Invoice writes check finite/non-negative values but do not consistently require every persisted money component and final total to be safe integer IRR. The JobPart API also still accepts fractional/ambiguous unit prices.

**Required sequence:** classify the read sources; mask or quarantine unverified financial fields in read APIs; after masking, switch verified Persian IRR to exact Toman; then enforce safe-integer IRR on invoice/prepay/wallet writers and shared ledger boundaries. Job Part input validation is implemented and merged in PR #133. Remaining work includes row-level read masking and integer-IRR validation/attestation for invoice, prepay, wallet, and ledger writers. Do not enable provenance flags until these changes and row-level evidence are complete.

Preserve the existing containment: `POST /api/payments` remains production-disabled and validates currency/integer IRR in non-production. Do not enable it before the authoritative provider lifecycle and ledger settlement are complete.

### Issue #99 — commercial policy

[Issue #99](https://github.com/mekanixir-prog/mekanix-app/issues/99) remains open. Earlier MEKANIX decisions establish these product constraints:

- Heavy machinery is the priority service category.
- Passenger support is limited to non-Iranian vehicles; Iran Khodro and Saipa are excluded.
- Technician labor/wage calculation is fixed-fee.
- VIP is annual and includes free periodic service visits only; repairs and parts are not free.

The following values and policies still require explicit owner decisions:

- Separate approved IRR rate cards for heavy machinery and the supported foreign passenger-vehicle segment.
- Labor, inspection, visit, per-kilometer, emergency and regional prices.
- Tax basis/rate and integer-IRR rounding.
- Platform commission percentage, calculation base and rounding. A prior 15% example was illustrative, not approved.
- Technician gross/net, escrow hold and release conditions.
- Annual VIP price, renewal/refund terms and whether any benefit beyond free periodic visits is approved.
- Integer-IRR withdrawal minimum/maximum, bank-only payout policy and fees.
- CARE's Toman input contract and exactly-once conversion boundary.

A sample 2,700,000-Toman service total and a 15% commission were examples, not production prices or owner approvals. Existing seed values and pricing-engine defaults are not approved production prices.

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
2. Complete issue #81 provenance classification and issue #99 commercial decisions.
3. Implement issue #130's IRR display/read masking and safe-integer writer boundaries.
4. Implement issue #24's authoritative payment and ledger lifecycle under the approved IRR contract.
5. Split the stale financial PR #78 work into small current-mainline changes; PRs #71/#73 are closed and must not be reopened wholesale.
6. Complete customer/technician/admin/CARE/warranty/refund/recovery E2E, failure injection, concurrency and performance testing.
7. Rehearse backup restore, migration and rollback in an isolated environment.
8. Produce a tagged Release Candidate and require all applicable workflows to pass on that exact SHA.
9. Activate hosting/domain/SMS/payment services shortly before launch, complete remote staging and real-provider smoke tests, then perform an explicit owner Go/No-Go.

## 8. Release evidence rule

Every completed gate must record its exact commit SHA, workflow/run URL, environment, test data, expected and actual result, reviewer/owner, and date. A green PR check is not a deployment; a local Docker test is not a remote staging rehearsal; a staging test is not a production test.

**Current release decision remains NO-GO.**