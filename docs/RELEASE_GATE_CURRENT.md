# MEKANIX — Current Release Gate

**Last verified:** 2026-11-14  
**Repository:** `mekanixir-prog/mekanix-app`  
**Purpose:** Current evidence-based Go/No-Go record. This document does not authorize merge, deployment, migrations, or production provider activation.

## 1. Current financial PRs

| PR | Current head | State | Exact-head workflows |
|---|---|---|---|
| [#137 — versioned IRR rate card](https://github.com/mekanixir-prog/mekanix-app/pull/137) | documentation-only refresh after tested code head below | Open, Draft, not merged | All seven workflows succeeded on code head `8272400f85ed6eacca2eb457f9b42b18baabbde9`; Docker E2E browser specs completed successfully |
| [#184 — financial read provenance and escrow release](https://github.com/mekanixir-prog/mekanix-app/pull/184) | `74e8fb914194f314458a247d38222730d8874fb8` | Open, Draft, not merged | All seven workflows — success |
| [#182 — reject generic payment status mutation](https://github.com/mekanixir-prog/mekanix-app/pull/182) | `a87b1070d97683a9da7773fdef9b86d533ba8463` | Open, Draft, not merged | All seven workflows — success |
| [#183 — prepay ownership and D1 ledger parity](https://github.com/mekanixir-prog/mekanix-app/pull/183) | `36e4d9b072592abc71d3c9207d3884be948ba7da` | Open, Draft, not merged | All seven workflows — success |
| [#186 — clean integrated financial candidate](https://github.com/mekanixir-prog/mekanix-app/pull/186) | Current clean branch `fix/financial-release-candidate-2026-11-14` | Open, Draft, not merged | Seven workflows are running on the latest integration head; no result is claimed until each finishes |

The #137 Docker E2E run on code head `8272400f85ed6eacca2eb457f9b42b18baabbde9` successfully built and started the Compose stack, passed health checks, verified PostgreSQL, verified production OTP fails closed without a real SMS provider, installed Bun/dependencies/Chromium, and completed the four Playwright browser specs (health, home, login, navigation) successfully. The Docker job completed successfully, including its cleanup step. Subsequent commits on the PR branch changed only this release-gate document; comparing the tested code head to the current branch head confirms that no application source or test files changed. PostgreSQL CI has now completed successfully, including migrations, isolated backup/restore rehearsal, TypeScript, tests, and build.

A clean integration candidate now exists in [PR #186](https://github.com/mekanixir-prog/mekanix-app/pull/186), based directly on `main`. It contains the #137 rate-card changes plus deliberate reconciliation of #184's per-record financial provenance and escrow controls, #182's admin payment-status guard, and #183's technician ownership CAS / D1 ledger ordering. The candidate preserves the #137 rate-card invoice path rather than replacing it with the older technician-fee-only flow from #184. The 14 #137/#184 overlapping paths and the #137/#182/#183 overlaps have been reconciled in the candidate code and tests. The earlier conflict-probe PRs were closed after GitHub confirmed they were not directly mergeable. PR #186 remains Draft and is not approved for merge; its complete CI and diff review are still required.

No merge, production deployment, remote D1 operation, production migration, production secret change, or provider activation is included in this status update.

## 2. What exact-head CI proves

The seven workflows on #137/#184/#182/#183 passed independently on their listed heads. PR #186 is the first candidate that tests the reconciled code together; its seven workflows must pass on one exact SHA. PostgreSQL CI includes migrations, an isolated backup/restore rehearsal, TypeScript, tests, and build. Docker E2E now includes Playwright browser smoke tests, a real HTTP + PostgreSQL business journey, BOLA checks, an injected transaction rollback, PostgreSQL outage/recovery, a k6 smoke profile, and a ZAP baseline. These new candidate steps are pending their first complete run on the latest #186 head.

Even a green #186 workflow does not prove a live staging deployment, a real SMS/payment provider round-trip, the full 100-VU staging load target, production D1 parity, or production operational readiness.

## 3. Confirmed remaining code/test gaps

### Business E2E

- `tests/e2e/business-flow.test.ts` remains a logical state-machine/library test with mocked DB, Redis, and rate-limit dependencies.
- New `scripts/e2e/business-http-flow.mjs` seeds real PostgreSQL test users/sessions and drives service request creation, technician assignment, job status transitions, rate-card invoice creation, customer approval, and completion over the live HTTP server.
- The HTTP flow also tests cross-customer request isolation, foreign invoice approval denial, cross-technician job mutation denial, technician wallet isolation, and production payment-simulator fail-closed behavior with zero Payment/Warranty rows.
- The workflow now includes four Playwright browser specs (health, home, login, navigation). The full HTTP journey is added but its first run on the candidate is pending.

**Gate:** complete the first exact-head run, fix any integration failures, and retain the HTTP test output. Real payment success and warranty creation remain outside this test because no real gateway is configured and the production simulator is intentionally disabled; the unit suite covers the simulated success/warranty path.

### Failure and resilience testing

- `tests/e2e/failure-scenarios.test.ts` still contains mocked Redis/rate-limit scenarios.
- Docker E2E now injects a real PostgreSQL outage, checks health fails closed, restarts PostgreSQL, and waits for health recovery.
- The HTTP business flow installs a temporary PostgreSQL trigger that rejects Job insertion after assignment claims, then verifies the transaction rolled back the ServiceRequest claim, technician claim, and Job write. The trigger is removed in a `finally` block.
- SMS/payment provider timeouts cannot yet be exercised against real adapters because no provider credentials or staging endpoints are configured. Production OTP and payment remain fail-closed.

**Gate:** complete the first candidate run; add provider-timeout fault injection when isolated provider adapters/endpoints are available; retain evidence for idempotent retry and recovery.

### Security validation

- CI runs dependency audit, repository hygiene, static security checks, and mocked BOLA/IDOR helper tests.
- `scripts/security-audit.sh` is a static heuristic gate; its pass is not a route-by-route authorization audit.
- The HTTP business flow adds real route-level BOLA checks for customer request isolation, invoice approval ownership, technician job ownership, and wallet role/tenant isolation.
- The Docker E2E workflow now runs `scripts/zap-scan.sh` using the maintained official ZAP container against the isolated local Docker stack and uploads its report. The first candidate scan is pending; this is not yet a staging ZAP report.
- Four Playwright browser smoke specs run in the same workflow but do not constitute a full route authorization suite.

**Gate:** complete the route inventory and positive/negative authorization matrix for all owned-resource and privileged endpoints; run and retain the staging ZAP report; triage Medium findings and block on High findings.

### Performance

- `scripts/load-test.js` exists and defines a staged ramp up to 100 virtual users with p95 < 500 ms, p99 < 1,000 ms, and request failure rate < 1%.
- The Docker E2E workflow now runs a 40-second, 5-VU k6 smoke profile and uploads `k6-summary.json`. Its first candidate result is pending. This is a smoke check only; the full script still defines the 100-VU staged ramp and p95/p99/failure thresholds.

**Gate:** run the full k6 profile against isolated staging and retain exact SHA, command, p95/p99, failure rate, CPU, memory, and database metrics. Do not treat the short CI smoke as a full load test.

### Staging, backup, restore, and rollback

- `docker-compose.staging.yml`, `scripts/deploy-staging.sh`, backup/restore scripts, and `docs/STAGING-DEPLOY.md` are present.
- CI validates staging Compose syntax and shell syntax, but does not deploy the isolated staging profile to a real staging host.
- PostgreSQL CI rehearses backup/restore in an ephemeral test environment. It is not a staging operations drill and does not establish production D1 backup/restore readiness.
- The staging readiness endpoint is intentionally expected to remain HTTP 503 while SMS is console and payment is simulator.

**Gate:** deploy the exact reviewed candidate SHA to isolated staging; verify health/readiness semantics; perform encrypted backup/restore to a separate disposable database; rehearse rollback to the previous known-good SHA; retain logs and evidence. Do not use production credentials or production data.

## 4. Release sequence

1. Finish reconciliation and review the clean main-based candidate in PR #186.
2. Review the complete combined diff and both SQLite/D1 and PostgreSQL migration tracks.
3. Run all CI workflows on the exact combined SHA and fix every failure.
4. Close the route-level authorization matrix and retain the local + staging security scan reports.
5. Complete the real HTTP business E2E and transactional/DB failure-injection tests; add real provider-timeout tests when test adapters are available.
6. Run and record the full k6 staging performance test.
7. Complete isolated staging, encrypted backup/restore, and rollback rehearsal.
8. Produce a Release Candidate tag tied to the exact approved SHA.
9. Only near release, configure real host/domain/TLS, SMS, payment, routing credentials, monitoring, and production backup; execute live smoke tests.
10. Obtain explicit owner Go/No-Go approval before public launch.

## 5. Go/No-Go

**Current decision: NO-GO for merge-to-release and public launch.**

The four original financial PRs have been consolidated into the clean Draft candidate #186; its latest CI run must complete successfully before it can be considered a valid combined code baseline. The candidate now contains the real HTTP business journey, route-level BOLA checks, transactional rollback injection, PostgreSQL outage/recovery, local ZAP baseline, and k6 smoke steps, but their first exact-head results are pending. Full staging deployment, full 100-VU performance evidence, real SMS/payment provider round-trips, production D1 operations, and final route-by-route authorization review remain open. Hosting, domain, live SMS, and payment activation are intentionally deferred until the Release Candidate stage; their absence does not justify enabling insecure fallbacks.

No historical financial records may be bulk-converted or re-labelled as part of this work. Do not enable production provenance or pricing flags merely to make readiness checks green.
