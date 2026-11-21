# MEKANIX Release Readiness Audit — 2026-11-21

## Executive decision

**NO-GO for public production release.** Continue code-level hardening and isolated CI validation. Do not activate live SMS, payment, wallet credit, withdrawal, payout, production D1 writes, or public deployment.

This audit records repository evidence and workflow results available on 2026-11-21. A passing unit/build workflow is not production certification.

## Source of truth and branch selection

- Repository: `mekanixir-prog/mekanix-app`
- Main baseline reviewed: `10080473dd6b87ec725a5c6c22803f5d5d872342` (2026-11-04)
- `main` contains the OpenNext/Cloudflare Worker build path, D1 binding, Cloudflare build workflow, and separate PostgreSQL/Docker validation.
- `cloudflare-migration` is **345 commits behind main** and has no commits ahead of main. It is stale and must not be used as the integration base.
- A clean audit branch was created from main: `audit/current-mainline-2026-11-21`.
- The latest main commit lookup returned no associated workflow runs through the connected GitHub workflow-run endpoint. This is missing evidence, not proof that CI failed or passed.

## Deployment architecture

The repository explicitly maintains two different deployment targets:

1. Node/Docker with PostgreSQL and Redis.
2. Cloudflare Workers + OpenNext + D1, with Worker bindings and D1-specific runtime constraints.

A successful build for one target does not validate the other. The Cloudflare build workflow builds and uploads a Worker artifact; it does not deploy it.

The current `wrangler.toml` includes:
- `SMS_PROVIDER = "console"`
- `PAYMENT_PROVIDER = "simulator"`
- D1 binding `DB`

These are non-live defaults. The production runbook explicitly says they are not acceptable for a user-facing release. No paid VPS/domain/SMS/payment activation is required for the present engineering phase.

## Current financial contract and code findings

### Confirmed owner decisions

- Canonical persisted accounting unit: integer IRR.
- Persian presentation: Toman, exact 10 IRR = 1 Toman.
- No implicit FX conversion and no heuristic conversion of historical values.
- Heavy machinery remains the priority; foreign passenger vehicles only, excluding Iran Khodro and Saipa.
- VIP benefit is periodic visits only; repairs and parts are excluded.

The monetary-unit decision is already recorded. Do not ask the owner to reselect IRR versus Toman.

### Confirmed remaining gates

- Historical row-level money provenance and a reviewed non-destructive reconciliation plan remain open (#81).
- Invoice, payment, wallet, withdrawal and ledger API read-side masking is not fully present on main. The inspected main `GET /api/wallets` returns the fresh wallet object; the inspected invoice GET returns the invoice object directly.
- `src/lib/format.ts` on main no longer applies implicit FX to IRR; it formats declared currency and rejects unsafe/non-integer IRR. The shared formatter still needs to be verified against the final exact Toman presentation contract and every UI call site.
- The authoritative payment lifecycle remains open (#24). Main's generic invoice payment route is simulator-only and returns 404 in production; gateway verify is simulator-only and returns 404 in production. Provider scaffolding must not be treated as a completed live gateway.
- Commercial tax, commission/escrow, VIP sales/refund, withdrawal limits and regional heavy-equipment tariff calibration must not be invented. PR #137 reports an initial fixed-fee baseline approval, while heavy-equipment values still need regional technician/supplier sampling; tax, commission and VIP sales remain disabled.
- Do not enable payment, wallet top-up, withdrawal or bank payout until implementation, provenance, approved commercial rules and staging evidence all pass.

## Active integration and security work

- PR #137 contains the editable versioned integer-IRR rate card, fixed-fee service pricing, separate heavy-equipment schedules, CARE quote/version handling, invoice lifecycle guards and migrations.
- PR #184 contains row-level financial read masking and strict provenance/integer guards. It overlaps PR #137 and must not be merged independently.
- PR #186 is the clean main-based integration candidate combining #137, #184, #182 and #183. It remains Draft and is not merge-ready.
- PR #195 is a Draft CSP nonce/response-header hardening change based on ZAP findings.
- PR #197 is a Draft infrastructure change for mandatory secrets, authenticated Redis health checks and isolated staging Compose.
- PR #191 is a Draft second-stage ZAP/k6 CI hardening change stacked on #190.

Do not merge overlapping financial PRs separately. Validate the consolidated main-based candidate as one exact SHA.

## Exact CI evidence inspected

### Financial release candidate branch

Branch: `fix/financial-release-candidate-2026-11-14`  
Head: `191834f7907718a33cc747e6ae3f47c9d8558e46`

Latest returned workflow results:
- CI: success
- Production readiness: success
- PostgreSQL CI: success
- Cloudflare Build: success
- CodeQL: success
- Secret Scan: success
- Docker E2E: **failure**

The failed Docker E2E job completed the Docker build, health checks, PostgreSQL migration verification, browser E2E, real HTTP business flow, k6 smoke test and PostgreSQL outage/recovery test. Its ZAP step failed because the wrapper received exit code 2 without a Medium finding explaining the threshold result. An earlier run on the same candidate also failed the Redis unauthenticated-command assertion and did not produce a valid ZAP JSON report.

### Staging/Redis branch

Branch: `fix/staging-compose-and-redis-auth-2026-11-14`  
Head: `c1866b048325433b6f5180871784b075c749561b`

Latest returned workflow results:
- CI: success
- Production readiness: success
- PostgreSQL CI: success
- Docker E2E: **failure**

The exact failing step is `Verify Redis password authentication`. The job reports: `Redis accepted an unauthenticated command`. The ZAP step on this run succeeded, but its output states that exit code 2 is attributable to Medium findings and requires human review. The browser/business/load steps were skipped because the Redis assertion failed earlier.

This is the immediate engineering blocker. Do not mark Docker E2E green until Redis authentication is proven by a negative unauthenticated test and a positive authenticated test on the same isolated stack.

## Next work sequence

1. Resolve the Redis authentication assertion on the current staging/infra branch. Add safe diagnostics for the effective Redis command/config without printing secrets. Prove unauthenticated PING is rejected and authenticated PING returns PONG.
2. Re-run Docker E2E and inspect the complete ZAP JSON/HTML/XML reports. Classify every Medium finding, link each to an owner/remediation or documented accepted risk, and require zero unresolved High findings.
3. Re-run all seven release workflows on one exact integrated candidate SHA. A green result on a different branch or earlier SHA does not count.
4. Review and consolidate #137/#184/#182/#183 into the clean main-based candidate; do not merge overlapping branches independently.
5. Complete the remaining payment lifecycle, invoice-to-technician ledger settlement, withdrawal/payout reconciliation and provider failure/replay tests. Keep real providers disabled.
6. Complete route-by-route authorization/BOLA/IDOR review, real HTTP business journey, performance profile and security report review.
7. Verify backup/restore and rollback using an isolated disposable environment; no production or remote D1 mutation.
8. Only after code-level gates pass, perform an isolated staging deployment. This can use local/temporary infrastructure; paid production hosting and live integrations remain deferred.
9. Produce a Release Candidate with exact-SHA evidence, reviewed migrations and rollback plan.
10. Near launch only: provision the selected hosting/domain, TLS, real SMS and gateway credentials, then perform sandbox/live smoke tests and Go/No-Go.

## Immediate acceptance criteria: Redis + Docker E2E

- Redis container's effective startup configuration demonstrably includes password enforcement.
- Authenticated `PING` returns `PONG`.
- An unauthenticated `PING`, with any inherited CLI auth variable explicitly removed, returns an authentication error and never `PONG`.
- The application connects using the configured secret.
- Secrets are never printed in logs or artifacts.
- Docker E2E completes all subsequent browser, HTTP business, load, ZAP and database failure/recovery steps.
- The exact final SHA has green required workflows; no skipped or cancelled check is counted as a pass.

## Evidence and safety boundaries

- No production deployment, remote D1 migration/write, real SMS, real payment, payout, production secret creation or domain activation was performed in this audit.
- No historical financial row was changed, relabelled or converted.
- A branch may be created for isolated work, but it is not a merge or release approval.


## Follow-up execution — 2026-11-21

### Redis authentication test hardening

- PR #197 head branch: `fix/staging-compose-and-redis-auth-2026-11-14`.
- Updated exact head: `3eea6cc6f1738ea9dcd8646056a2ad3590209032`.
- Updated `.github/workflows/docker-e2e.yml` to inspect the effective Redis server command without printing the password, perform an authenticated PING from inside the container, explicitly unset inherited `REDISCLI_AUTH` for the negative PING, and require a `NOAUTH` response.
- CI started for the updated head: CI success; Production readiness failed at dependency audit; PostgreSQL CI and Docker E2E were still in progress at the time of this update.
- The previous Redis test failure was `Redis accepted an unauthenticated command`. The new test result is pending; do not mark Redis fixed until the new Docker E2E run completes.

### Newly discovered dependency security blocker

- The updated Production readiness run executes `bun audit --audit-level=moderate` and fails.
- The audit output identifies eight Next.js advisories against the locked `next@16.4.3` dependency (one reported High and seven Moderate by Bun).
- Next.js upstream tag `v16.4.5` exists and is the published patch line for the November advisories; upstream tag `v16.4.6` also exists. The repository should move to the latest verified stable patch and regenerate `bun.lock` with the pinned Bun 1.4.4 runtime.
- Do not weaken the audit threshold to make CI green. Upgrade the dependency, regenerate the lockfile, then require the full CI matrix on the new exact SHA.
- Upstream evidence: Next.js tags `v16.4.5` and `v16.4.6`; the November advisories list affected Next.js versions through 16.4.4 and patched 16.4.5. See the upstream advisory index: https://github.com/vercel/next.js/security/advisories.

### Current follow-up gates

1. Finish the in-progress Docker E2E and PostgreSQL CI for PR #197 head `3eea6cc6f1738ea9dcd8646056a2ad3590209032`.
2. Fix the Next.js dependency audit by updating Next.js and regenerating `bun.lock`; do not bypass audit.
3. Re-run CI, Production readiness, PostgreSQL CI, Docker E2E, Cloudflare Build, CodeQL and Secret Scan on the exact same integrated candidate SHA.
