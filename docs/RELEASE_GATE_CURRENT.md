# MEKANIX — Current Release Gate

**Last verified:** 2026-11-11  
**Repository:** `mekanixir-prog/mekanix-app`  
**Purpose:** Current evidence-based Go/No-Go record. This document does not authorize merge, deployment, migrations, or production provider activation.

## 1. Current financial PRs

| PR | Current head | State | Exact-head workflows |
|---|---|---|---|
| [#137 — versioned IRR rate card](https://github.com/mekanixir-prog/mekanix-app/pull/137) | `d36d67e9803438320509ec580e3206582f6a2b9c` | Open, Draft, not merged | CI, Production readiness, PostgreSQL CI, Docker E2E, Cloudflare Build, CodeQL, Secret Scan — all success |
| [#184 — financial read provenance and escrow release](https://github.com/mekanixir-prog/mekanix-app/pull/184) | `74e8fb914194f314458a247d38222730d8874fb8` | Open, Draft, not merged | CI, Production readiness, PostgreSQL CI, Docker E2E, Cloudflare Build, CodeQL, Secret Scan — all success |

Both PRs currently report mergeable against `main`. This does **not** establish that they can be merged together. The PR heads have diverged: comparing #137 head to #184 head reports 529 commits behind and 64 commits ahead. They share 14 changed paths, including invoice routes, payment and wallet APIs, provenance helpers, wallet-release code, and financial tests. Do not merge either independently until a single combined candidate is assembled and the combined diff is reviewed and tested.

No merge, production deployment, remote D1 operation, production migration, production secret change, or provider activation is included in this status update.

## 2. What exact-head CI proves

The seven workflows above passed independently on each listed head. The PostgreSQL workflow runs migrations, an isolated backup/restore rehearsal, TypeScript, tests, and build. Docker E2E builds and starts the default Compose stack, checks PostgreSQL migration objects and health, and verifies production OTP fails closed when no real SMS provider is configured.

These are useful automated checks. They do not prove a live staging deployment, complete browser journey, live SMS/payment round-trip, production D1 parity, or production operational readiness.

## 3. Confirmed remaining code/test gaps

### Business E2E

- `tests/e2e/business-flow.test.ts` is a logical state-machine/library test. Its DB, Redis, and rate-limit dependencies are mocked; it is not a full HTTP-server plus real-database business journey.
- Playwright is configured for `tests/browser` and contains four browser specs (health, home, login, navigation), but none of the current GitHub Actions workflows invokes `bun run test:e2e`.
- Docker E2E verifies container startup, health, selected PostgreSQL schema objects, and the production OTP fail-closed response. It does not execute the full customer → service request → dispatch → technician → approval → invoice → warranty journey.

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

1. Consolidate #137 and #184 into one reviewed candidate without losing either branch's protections.
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

The independent PR CI matrices are green, but the financial PRs are not consolidated, and the business E2E, failure-injection, ZAP, measured performance, and real staging evidence gates remain open. Hosting, domain, live SMS, and payment activation are intentionally deferred until the Release Candidate stage; their absence is not a reason to stop code/test work now.

No historical financial records may be bulk-converted or re-labelled as part of this work. Do not enable production provenance or pricing flags merely to make readiness checks green.
