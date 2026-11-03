# MEKANIX Engineering Documentation

> **Current audited code baseline:** `28d13e32c2046ed2743d549a8ab3c24bdd972054` (2026-11-03). The dated release audit is the source of truth for code and release status.

## Start here

1. [Release Readiness Audit — 2026-11-01, updated 2026-11-03](RELEASE_READINESS_AUDIT_2026-11-01.md) — current merged work, open blockers, and required evidence.
2. [Release Checklist](RELEASE_CHECKLIST.md) — operational gates split between work to finish now and services to activate shortly before launch.
3. [Production Deployment Runbook](PRODUCTION_DEPLOYMENT_RUNBOOK.md) — staging, configuration, deployment, smoke tests, and rollback sequence.
4. [Payment & Wallet Audit](AUDIT_PAYMENT_WALLET.md) — provider, invoice, wallet, payout, and idempotency findings.
5. [Financial Unit Contract Audit](FINANCIAL_UNIT_CONTRACT_AUDIT_2026-11-02.md) — current currency-unit inconsistencies, proposed IRR target, and owner-approval/migration gates.
6. [Financial Data Provenance Inventory](FINANCIAL_DATA_PROVENANCE_INVENTORY_2026-11-02.md) and [Financial API Flow Audit](FINANCIAL_API_FLOW_AUDIT_2026-11-02.md) — source units, seed risks, and money-flow validation boundaries.
7. [D1 / Prisma Audit](AUDIT_D1_PRISMA.md) — adapter, migrations, transaction, and concurrency constraints.
8. [Security Audit](AUDIT_SECURITY.md) and [Phase 3 Security Audit v2](PHASE3_SECURITY_AUDIT_V2.md) — security review history.
9. [Cloudflare Build Audit](AUDIT_CLOUDFLARE_BUILD.md) and [CI/CD Audit](AUDIT_CICD.md) — build and workflow details.
10. [Idempotency Call-Site Inventory](IDEMPOTENCY_CALLSITE_INVENTORY.md) — endpoint-level deduplication contracts.
11. [Architecture Blueprint](ARCHITECTURE.md), [SEO Implementation Notes](SEO_IMPLEMENTATION.md), [Project Status](PROJECT_STATUS.md), and [Roadmap](ROADMAP.md).

## How to interpret evidence

- Audits are point-in-time reports. Always check the exact commit SHA and workflow run linked by the report.
- A green workflow proves only that the named workflow passed for its tested commit and environment. It does not prove production secrets, external providers, remote D1 state, DNS/TLS, live SMS, or live payments.
- Historical checklists and reports may contain successful staging/deployment claims from older commits. Do not treat them as current Go/No-Go evidence.
- Do not run `prisma db push --accept-data-loss`, `prisma migrate reset`, or a remote D1 migration against production without a reviewed plan, verified backup/restore path, and explicit release approval.
- VPS/hosting, production domain/DNS/HTTPS, live SMS, live payment credentials, and real transactions are intentionally deferred until shortly before launch.

## Status ownership

Update the release audit whenever main changes materially, a blocker is resolved, or a new staging/production verification is performed. Record exact commit SHAs and evidence links. Never mark a release gate complete based only on a local build or a PR check from a different commit.
