# Current Release Gate — 2026-10-30

This file supersedes older release-status summaries where they conflict with the current branch and open pull requests. It is a readiness record, not permission to deploy or activate production services.

## Current release blockers

1. **Financial correctness changes are still Draft PRs.**
   - PR #10 — gateway verification idempotency.
   - PR #17 — canonical USD accounting, stacked on PR #10.
   - PR #12 — atomic wallet escrow release.
   - PR #16 — scheduled escrow release worker, stacked on PR #12.
   - PR #13 — atomic/idempotent prepay ledger.
   - PR #14 — atomic withdrawal request creation, stacked on PR #13.
   - PR #15 — admin withdrawal review and payout operations, stacked on PR #14.
   None of these PRs has been merged by this work.

2. **Real D1 integration validation is still required.**
   Unit tests mock D1 batch behavior. Before merge/rollout, run the migration and financial transaction paths against an isolated D1 database, including concurrency and rollback scenarios.

3. **Real payment checkout is not wired.**
   Zarinpal and IDPay adapter code exists, but the production gateway flow remains simulator-only and returns 404 in production. NextPay is still a stub. Do not set payment credentials and assume checkout is live.

4. **Real SMS delivery needs complete credentials and a live phone test.**
   Provider names alone are not enough. Kavenegar requires its API key; MeliPayamak and Farapayamak require username, password, and sender. A successful configuration check is not a substitute for a real delivery test.

5. **Production infrastructure remains intentionally deferred.**
   Domain, production hosting, SMS activation, payment credentials, and deployment are to be activated near release. No production database, secret, DNS, provider credential, or deployment was changed by these code changes.

## Readiness endpoint contract

In production, GET /api/ready must return HTTP 503 until all of these are true:
- a real SMS provider is selected and all required credentials are present;
- a real payment provider is configured and production checkout/callback/verification routes are wired;
- the database is reachable and is not a local file: SQLite database.

The provider status returned by GET /api/health is diagnostic only. It does not prove a live transaction or SMS delivery succeeded.

## Required Go/No-Go evidence

- All dependency PRs reviewed and merged in dependency order, with CI green on the resulting main commit.
- Isolated D1 migration and transaction tests pass.
- A real SMS delivery test succeeds on a controlled Iranian phone.
- A real payment sandbox round-trip succeeds, including callback verification, locked amount/currency checks, duplicate callbacks, and refund/reconciliation behavior.
- Production backups, restore rehearsal, monitoring, domain/TLS, and rollback plan are verified.
- Explicit owner Go/No-Go approval.

Until then, the release remains **blocked / not production-ready**.