# MEKANIX — Current Release Gate

**Last verified:** 2026-11-14  
**Repository:** `mekanixir-prog/mekanix-app`  
**Purpose:** Current evidence-based Go/No-Go record. This document does not authorize merge, deployment, migrations, or production provider activation.

## 1. Current financial PRs

| PR | Current head | State | Exact-head workflows |
|---|---|---|---|
| [#137 — versioned IRR rate card](https://github.com/mekanixir-prog/mekanix-app/pull/137) | `8272400f85ed6eacca2eb457f9b42b18baabbde9` | Open, Draft, not merged | CI, Production readiness, PostgreSQL CI, Cloudflare Build, CodeQL, Secret Scan — success; Docker E2E still running (Playwright browser steps not yet reached) |
| [#184 — financial read provenance and escrow release](https://github.com/mekanixir-prog/mekanix-app/pull/184) | `74e8fb914194f314458a247d38222730d8874fb8` | Open, Draft, not merged | All seven workflows — success |
| [#182 — reject generic payment status mutation](https://github.com/mekanixir-prog/mekanix-app/pull/182) | `a87b1070d97683a9da7773fdef9b86d533ba8463` | Open, Draft, not merged | All seven workflows — success |
| [#183 — prepay ownership and D1 ledger parity](https://github.com/mekanixir-prog/mekanix-app/pull/183) | `36e4d9b072592abc71d3c9207d3884be948ba7da` | Open, Draft, not merged | All seven workflows — success |

The latest #137 Docker E2E run has successfully built and started the Compose stack, passed health checks, verified PostgreSQL, and verified production OTP fails closed without a real SMS provider. Bun setup is complete; dependency installation is in progress. Chromium installation and the four Playwright browser specs (health, home, login, navigation) are still pending. PostgreSQL CI has now completed successfully, including migrations, isolated backup/restore rehearsal, TypeScript, tests, and build.

The branches are not a safe merge set. Compared with `main`, #137 is 532 commits ahead (161 changed files), #184 is 64 ahead (17 files), #182 is 3 ahead (3 files), and #183 is 5 ahead (2 files). #137 and #184 share 14 changed paths; #137 and #182 share 2; #137 and #183 share 2. The #137/#184 overlap includes invoice routes, payments/wallet APIs, provenance helpers, wallet-release code, staging seed SQL, and financial tests. Do not merge any independently until a single combined candidate is assembled, each overlap is reconciled deliberately, and the complete resulting diff is reviewed and tested.

No merge, production deployment, remote D1 operation, production migration, production secret change, or provider activation is included in this status update.

## 2. What exact-head CI proves

The seven workflows above passed independently on each listed head. The PostgreSQL workflow runs migrations, an isolated backup/restore rehearsal, TypeScript, tests, and build. Docker E2E builds and starts the default Compose stack, checks PostgreSQL migration objects and health, and verifies production OTP fails closed when no real SMS provider is configured.

These are useful automated checks. They do not prove a live staging deployment, complete browser journey, live SMS/payment round-trip, production D1 parity, or production operational readiness.

## 3. Confirmed remaining code/test gaps

### Business E2E

- `tests/e2e/business-flow.test.ts` is a logical state-machine/library test. Its DB, Redis, and rate-limit dependencies are mocked; it is not a full HTTP-server plus real-database business journey.
- Playwright is configured for `tests/browser` and contains four browser specs (health, home, login, navigation). The latest #137 Docker E2E workflow now installs Bun/dependencies/Chromium and invokes `bun run test:e2e` against the live isolated Docker stack; its first execution is still pending at the current checkpoint.
- Docker E2E now includes browser smoke tests after container startup, PostgreSQL checks, and the production OTP fail-closed check. The first Playwright run is not yet complete. It still does not execute the full customer → service request → dispatch → technician → approval → invoice → warranty journey.

**Gate:** add and run an isolated, repeatable HTTP/API business E2E against a real test database, including customer ownership, technician assignment, status transitions, invoice approval, and warranty. Add browser smoke tests to CI separately.

### Failure and resilience testing

- `tests/e2e/failure-scenarios.test.ts` contains useful scenarios, but its Redis and rate-limit modules are mocked. The Redis fallback test explicitly acknowledges that it does not import and execute the real rate-limit implementation.
- No evidence is attached for a live staging exercise of database interruption, Redis outage, SMS timeout, payment provider timeout, or recovery after partial multi-write failure.

**Gate:** exercise real adapters against controllable failing test services or fault-injection proxies; verify fail-closed behavior, idempotent retry, and recovery without duplicate writes.

### Security validation

- CI runs dependency audit, repository hygiene, static security checks, and mocked BOLA/IDOR helper tests.
- `scripts/security-audit.sh` is a static heuristic gate; its pass is not a route-by-route authorization audit.
- `scripts/zap-scan.sh` exists, but no staging ZAP report is attached to the current candidate.
- The Playwright browser specs are not currently part of CI.

**Gate:** map every owned-resource and privileged route to positive and negative authorization tests; run the ZAP baseline against isolated staging; triage all Medium findings and block on High findings.

### Performance

- `scripts/load-test.js` exists and defines a staged ramp up to 100 virtual users with p95 < 500 ms, p99 < 1,000 ms, and request failure rate < 1%.
- No measured k6 run, environment description, resource metrics, or result artifact is attached.

**Gate:** run k6 against the isolated staging candidate and retain the exact SHA, command, p95/p99, failure rate, CPU, memory, and database metrics. Do not infer performance readiness from the script or CI.

### Staging, backup, restore, and rollback

- `docker-compose.staging.yml`, `scripts/deploy-staging.sh`, backup/restore scripts, and `docs/STAGING-DEPLOY.md` are present.
- CI validates staging Compose syntax and shell syntax, but does not deploy the isolated staging profile to a real staging host.
- PostgreSQL CI rehearses backup/restore in an ephemeral test environment. It is not a staging operations drill and does not establish production D1 backup/restore readiness.
- The staging readiness endpoint is intentionally expected to remain HTTP 503 while SMS is console and payment is simulator.

**Gate:** deploy the exact reviewed candidate SHA to isolated staging; verify health/readiness semantics; perform encrypted backup/restore to a separate disposable database; rehearse rollback to the previous known-good SHA; retain logs and evidence. Do not use production credentials or production data.

## 4. Release sequence

1. Consolidate #137, #184, #182, and #183 into one reviewed candidate without losing either branch's protections.
2. Review the complete combined diff and both SQLite/D1 and PostgreSQL migration tracks.
3. Run all CI workflows on the exact combined SHA.
4. Close route-level authorization and security scan gates.
5. Run real HTTP business E2E and failure-injection tests.
6. Run and record the k6 staging performance test.
7. Complete isolated staging, encrypted backup/restore, and rollback rehearsal.
8. Produce a Release Candidate tag tied to the exact approved SHA.
9. Only near release, configure real host/domain/TLS, SMS, payment, routing credentials, monitoring, and production backup; execute live smoke tests.
10. Obtain explicit owner Go/No-Go approval before public launch.

## 5. Go/No-Go

**Current decision: NO-GO for merge-to-release and public launch.**

The independent PR CI matrices for #184, #182, and #183 are green. On #137, six workflows are green and Docker E2E is still running; its newly added Playwright execution has not yet produced a result. The financial PRs are not consolidated, and the business E2E, failure-injection, ZAP, measured performance, and real staging evidence gates remain open. Hosting, domain, live SMS, and payment activation are intentionally deferred until the Release Candidate stage; their absence is not a reason to stop code/test work now.

No historical financial records may be bulk-converted or re-labelled as part of this work. Do not enable production provenance or pricing flags merely to make readiness checks green.
