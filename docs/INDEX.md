# MEKANIX Engineering Documentation

> **Current audited code baseline:** `e03f84da91db464edd2ca6ae32fdd156174c948b` (2026-11-04). The [2026-11-04 Release Readiness Audit](RELEASE_READINESS_AUDIT_2026-11-04.md) is the current source of truth for mainline and release status.

## Start here

1. [Release Readiness Audit — 2026-11-04](RELEASE_READINESS_AUDIT_2026-11-04.md) — exact mainline baseline, current PR/issue disposition, CI evidence, repository governance, financial blockers, and launch gates.
2. [Historical Release Readiness Audit — 2026-11-01, updated 2026-11-03](RELEASE_READINESS_AUDIT_2026-11-01.md) — prior point-in-time findings; superseded by the 2026-11-04 audit.
3. [Release Checklist](RELEASE_CHECKLIST.md) — operational gates split between work to finish now and services to activate shortly before launch.
4. [Production Deployment Runbook](PRODUCTION_DEPLOYMENT_RUNBOOK.md) — staging, configuration, deployment, smoke tests, and rollback sequence.
5. [Payment & Wallet Audit](AUDIT_PAYMENT_WALLET.md) — provider, invoice, wallet, payout, and idempotency findings.
6. [Payment Lifecycle Contract](PAYMENT_LIFECYCLE_CONTRACT_2026-11-03.md) — proposed server-authoritative payment, verification, idempotency and fulfillment design; not an implementation approval.
7. [Financial Unit Contract Audit](FINANCIAL_UNIT_CONTRACT_AUDIT_2026-11-02.md) — currency-unit inconsistencies and implementation/migration gates. The owner approved integer IRR on 2026-11-03; historical provenance and rollout remain incomplete.
8. [Financial Data Provenance Inventory](FINANCIAL_DATA_PROVENANCE_INVENTORY_2026-11-02.md) — source units, seed assignments, historical-value provenance, and migration risks.
9. [Financial API Flow Audit](FINANCIAL_API_FLOW_AUDIT_2026-11-02.md) — money sources, validation boundaries, and payment/wallet/withdrawal flow risks.
10. [D1 / Prisma Audit](AUDIT_D1_PRISMA.md) — adapter, migrations, transaction, and concurrency constraints.
11. [Security Audit](AUDIT_SECURITY.md) and [Phase 3 Security Audit v2](PHASE3_SECURITY_AUDIT_V2.md) — security review history.
12. [Cloudflare Build Audit](AUDIT_CLOUDFLARE_BUILD.md) and [CI/CD Audit](AUDIT_CICD.md) — build and workflow details.
13. [Idempotency Call-Site Inventory](IDEMPOTENCY_CALLSITE_INVENTORY.md) — endpoint-level deduplication contracts.
14. [Architecture Blueprint](ARCHITECTURE.md), [SEO Implementation Notes](SEO_IMPLEMENTATION.md), [Project Status](PROJECT_STATUS.md), and [Roadmap](ROADMAP.md).

## How to interpret evidence

- Audits are point-in-time reports. Always check the exact commit SHA and workflow run linked by the report.
- A green workflow proves only that the named workflow passed for its tested commit and environment. It does not prove production secrets, external providers, remote D1 state, DNS/TLS, live SMS, or live payments.
- Historical checklists and reports may contain successful staging/deployment claims from older commits. Do not treat them as current Go/No-Go evidence.
- Do not run `prisma db push --accept-data-loss`, `prisma migrate reset`, or a remote D1 migration against production without a reviewed plan, verified backup/restore path, and explicit release approval.
- VPS/hosting, production domain/DNS/HTTPS, live SMS, live payment credentials, and real transactions are intentionally deferred until shortly before launch.

## Status ownership

Update the release audit whenever main changes materially, a blocker is resolved, or a new staging/production verification is performed. Record exact commit SHAs and evidence links. Never mark a release gate complete based only on a local build or a PR check from a different commit.
