# MEKANIX Engineering Documentation

> **Documentation status:** current audit based on main commit `1691c87970835af37577946e422d66e26e3baf4f`. Read the dated release audit before treating historical status documents as current.

## Start here

1. [Release Readiness Audit — 2026-10-31](RELEASE_READINESS_AUDIT_2026-10-31.md) — current mainline status, blockers, and evidence required before release.
2. [Historical Release Readiness Audit](RELEASE_READINESS_AUDIT.md) — prior snapshot; not authoritative for current status.
3. [Production Deployment Runbook](PRODUCTION_DEPLOYMENT_RUNBOOK.md) — safe sequence for configuration, database checks, staging, deployment, smoke tests, and rollback.
4. [SEO Implementation Notes](SEO_IMPLEMENTATION.md) — Persian public pages, metadata, sitemap/robots behavior, and SEO launch checks.
5. [Architecture Blueprint](ARCHITECTURE.md) — product and system architecture.
6. [Cloudflare Build Audit](AUDIT_CLOUDFLARE_BUILD.md) — Workers build path and constraints.
7. [D1 / Prisma Audit](AUDIT_D1_PRISMA.md) — database adapter, migrations, and transaction/concurrency limitations.
8. [Payment & Wallet Audit](AUDIT_PAYMENT_WALLET.md) — payment, wallet, VIP, and idempotency findings.
9. [Idempotency Call-Site Inventory](IDEMPOTENCY_CALLSITE_INVENTORY.md) — endpoint-level deduplication contracts and safe offline retry boundaries.
10. [Security Audit](AUDIT_SECURITY.md) and [Phase 3 Security Audit v2](PHASE3_SECURITY_AUDIT_V2.md) — security review history.
11. [CI/CD Audit](AUDIT_CICD.md) — workflow and deployment automation review.
12. [Release Checklist](RELEASE_CHECKLIST.md) and [Rollback Runbook](ROLLBACK.md) — operational checklists.
13. [Project Status](PROJECT_STATUS.md) and [Roadmap](ROADMAP.md) — project-level tracking.

## How to interpret audit documents

- Audits are point-in-time reports. Their stated branch, commit, test counts, and conclusions may refer to an earlier revision.
- A green GitHub Actions run proves only that the named workflow passed for its tested commit and environment. It does not prove production secrets, external providers, remote D1 data, DNS/TLS, or live payment/SMS behavior.
- The current release decision must follow `RELEASE_READINESS_AUDIT_2026-10-31.md`, not a historical statement such as “ready to ship” in an older report.
- Never run `prisma db push --accept-data-loss`, `prisma migrate reset`, or a remote D1 migration against production without a reviewed plan, backup/recovery strategy, and explicit release approval.
- No deployment or remote database mutation is authorized by these documents. The runbook describes gates; it does not claim they have been executed.

## Status ownership

Update the release audit whenever the release candidate commit changes, a blocker is resolved, or a new production verification is performed. Record the exact commit SHA and evidence link for every status change.
