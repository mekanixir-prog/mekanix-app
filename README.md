# MEKANIX

**Mobile repair and service platform — engineering repository**

MEKANIX is being developed as a service platform for repair requests, asset/equipment records, technician workflows, service tracking, and related operational tools. The initial product focus is heavy machinery, with the customer-facing experience intended for Persian-speaking users.

> **Release status: NOT PRODUCTION-READY.** This repository currently contains implementation and deployment-validation work under review. A green build is not proof that live SMS, payment, Cloudflare D1, domain/TLS, or production operations are ready.

[![CI](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/ci.yml)
[![Cloudflare Build](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/cloudflare-build.yml/badge.svg?branch=main)](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/cloudflare-build.yml)
[![PostgreSQL CI](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/postgresql-ci.yml/badge.svg?branch=main)](https://github.com/mekanixir-prog/mekanix-app/actions/workflows/postgresql-ci.yml)

## Contents

- [Product scope](#product-scope)
- [Technology and deployment paths](#technology-and-deployment-paths)
- [Repository map](#repository-map)
- [Prerequisites](#prerequisites)
- [Local development](#local-development)
- [Validation commands](#validation-commands)
- [Environment configuration](#environment-configuration)
- [Database and migration safety](#database-and-migration-safety)
- [Authentication, payments, and VIP](#authentication-payments-and-vip)
- [Cloudflare preview and production](#cloudflare-preview-and-production)
- [Release gates](#release-gates)
- [Engineering documentation](#engineering-documentation)
- [Contributing](#contributing)
- [Security reporting](#security-reporting)

## Product scope

The platform is intended to support the service lifecycle:

1. Customer signs in with a mobile number and one-time password (OTP).
2. Customer registers a vehicle or piece of equipment.
3. Customer creates and tracks a service/repair request.
4. Operations assigns an appropriate technician.
5. Technician updates mission progress and service outcomes.
6. Customer and operations can review status, history, and notifications.

The exact scope and availability of each journey must be confirmed against the current implementation and release audit; this list is a product direction, not a claim that every journey is production-complete.

## Technology and deployment paths

The repository contains a Next.js application, TypeScript, Prisma, Vitest, Playwright, Docker-based runtime support, and a Cloudflare Workers/OpenNext build path. Provider-specific database migration tracks exist for SQLite/D1 and PostgreSQL.

There are **two different deployment targets** and they must not be conflated:

- **Node/Docker:** conventional server/container build and its own runtime dependencies.
- **Cloudflare Workers + D1:** OpenNext Worker artifact, Cloudflare bindings, Worker-compatible runtime constraints, and D1-specific migration/verification.

A successful build for one target does not validate the other target's runtime.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | Application routes, UI, and server-side application code |
| `prisma/schema.prisma` | Prisma data model |
| `prisma/migrations/` | Primary migration history; verify provider compatibility before use |
| `prisma/migrations-postgresql/` | PostgreSQL-specific migration track |
| `.github/workflows/` | CI, Cloudflare build, PostgreSQL CI, readiness checks, Docker E2E |
| `scripts/` | Repository hygiene and build/validation helpers |
| `tests/` | Unit and integration-oriented tests |
| `docs/` | Architecture, audits, release gates, and operational runbooks |
| `wrangler.toml` | Cloudflare Worker configuration and bindings |

## Prerequisites

Use the package-manager/runtime versions pinned or required by the repository and CI. The current lockfile is `bun.lock`; Bun is the expected package manager for reproducible installation. Docker is required for Docker E2E checks. Wrangler/Cloudflare access is only required for Cloudflare-specific local or remote operations.

Check versions before starting:

```bash
node --version
bun --version
docker --version
```

If a command fails because a local runtime differs from CI, reproduce it in the same Linux/CI environment before changing project configuration.

## Local development

1. Clone the repository and switch to the intended branch.
2. Install from the lockfile.
3. Create a local-only environment file from the relevant example.
4. Generate Prisma Client.
5. Configure a disposable local database.
6. Start the development server.

```bash
git clone https://github.com/mekanixir-prog/mekanix-app.git
cd mekanix-app
git checkout main
bun install --frozen-lockfile
cp .env.example .env
bun run db:generate
bun run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Review every variable in `.env.example` and `.dev.vars.example`; do not copy production credentials into a local file. The local database setup method depends on the selected Prisma provider and should only target disposable local data.

The default development server uses port 3000. If your environment does not provide a compatible database, configure a local database first; do not point development commands at production.

## Validation commands

Run checks before opening or updating a pull request:

```bash
bun install --frozen-lockfile
bun run db:generate
bun run lint
bunx tsc --noEmit
bun run check:hygiene
bun run test
bun run build
bash scripts/build-cloudflare.sh
```

Additional checks where applicable:

```bash
bun run test:coverage
bun run test:e2e
```

Use the exact commands in the workflow files as the source of truth if they differ from this list. Record the commit SHA and CI run URLs when reporting results. Never describe tests as passed unless they were actually executed and their exit status was successful.

## Environment configuration

Configuration differs by runtime. Review `wrangler.toml`, `.env.example`, and `.dev.vars.example` together, and verify the names read by the application code.

At the time of the current release audit, `wrangler.toml` contains `SMS_PROVIDER = "console"` and `PAYMENT_PROVIDER = "simulator"`. These are **not real production providers**. They must not be represented as live SMS or live payment.

- Use local `.env` or `.dev.vars` only for local development.
- Use Cloudflare secret storage for Worker secrets.
- Never commit real API keys, OTP signing secrets, JWT secrets, database credentials, or payment-gateway secrets.
- Keep preview and production Worker bindings, D1 database IDs, and provider credentials separate.
- The readiness endpoint should remain fail-closed until required production configuration is verified.

## Database and migration safety

Database migrations are release-critical and can affect customer, asset, payment, wallet, and subscription records.

**Never run the following against production:**

- `prisma db push --accept-data-loss`
- `prisma migrate reset`
- `bun run setup` unless its exact effects have been reviewed and it is confirmed to target a disposable local database

Before a production migration:

1. Confirm the target database and provider.
2. Take a backup/export and verify that it is readable.
3. Review the full SQL migration and compare the provider-specific tracks.
4. Run preflight queries against a backup or staging copy.
5. Stop if duplicate payment IDs or multiple ACTIVE VIP subscriptions are found; reconcile them explicitly and preserve an audit trail.
6. Apply to staging, validate schema/data and rehearse recovery.
7. Obtain approval for the exact migration and commit SHA before production execution.

The existence of migration files is not proof that a remote D1 database has been migrated. Do not run remote migrations based only on this README.

## Authentication, payments, and VIP

- OTP needs expiration, single-use semantics, resend/guess throttling, and safe logging.
- Authorization must verify ownership of every customer-controlled resource on the server.
- Payment callbacks must verify authenticity, amount/currency, replay resistance, idempotency, and out-of-order/duplicate behavior.
- Wallet balances and VIP entitlements must be reconciled against payment records.
- A unique database constraint is the final guard for concurrency-sensitive invariants; an application-level read followed by a write is not an atomic lock.
- Test concurrency against each supported database engine. A mocked unit test is useful but is not a substitute for a database integration test.

Do not enable real-money transactions until the release audit's payment gates are complete.

## Cloudflare preview and production

The Cloudflare build workflow validates/builds the Worker artifact; it does **not** by itself prove a successful deployment. Use a separate preview Worker and D1 database before production.

Minimum preview verification:

- Worker starts and serves the expected routes.
- `/api/health` reports the expected liveness/database state.
- `/api/ready` returns success only when all required readiness checks pass.
- D1 bindings and schema match the approved migration state.
- OTP, asset registration, service request, technician update, authorization, notifications, and admin workflows are tested.
- Payment sandbox callbacks, duplicate callbacks, invalid signatures, and concurrent subscription attempts are tested.
- Error logs and monitoring do not expose secrets or sensitive personal data.
- Backup/restore and Worker rollback procedures have been rehearsed.

See the production runbook for the controlled sequence. Do not paste secret values or production customer data into issues or logs.

## Release gates

The release decision is currently **NOT APPROVED FOR PRODUCTION** until evidence is attached for:

- [ ] Review of the complete PR diff and migration SQL.
- [ ] Required GitHub Actions checks green on the exact release candidate SHA.
- [ ] D1 and PostgreSQL migration tracks verified for their intended providers.
- [ ] Duplicate-data preflight clean, or explicit reviewed reconciliation completed.
- [ ] Real SMS provider configured and verified in a controlled environment.
- [ ] Payment gateway sandbox certification and callback/idempotency checks completed; otherwise payment stays disabled.
- [ ] Security-negative tests for authorization, OTP abuse, and role boundaries.
- [ ] Live Cloudflare preview smoke test and D1 migration rehearsal.
- [ ] Backup restore and rollback rehearsal.
- [ ] Production secrets, domain/DNS/TLS, monitoring, and incident ownership verified.

The release audit is the current decision record; older audit documents may contain historical branch/commit states.

## Engineering documentation

- [Documentation index](docs/INDEX.md)
- [Release readiness audit](docs/RELEASE_READINESS_AUDIT.md)
- [Production deployment runbook](docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md)
- [Architecture blueprint](docs/ARCHITECTURE.md)
- [Cloudflare build audit](docs/AUDIT_CLOUDFLARE_BUILD.md)
- [D1 / Prisma audit](docs/AUDIT_D1_PRISMA.md)
- [Payment & wallet audit](docs/AUDIT_PAYMENT_WALLET.md)
- [CI/CD audit](docs/AUDIT_CICD.md)
- [Rollback runbook](docs/ROLLBACK.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## Contributing

1. Create a focused feature/fix branch from an up-to-date base.
2. Keep changes scoped and avoid mixing unrelated refactors with migration or security changes.
3. Add tests for new behavior and for the failure/race conditions it changes.
4. Run relevant local checks and wait for required CI checks on the exact commit.
5. Describe behavior, migration impact, test evidence, and known risks in the PR.
6. Never merge or deploy solely because a build is green; follow the release gates.

## Security reporting

Do not publish credentials, OTPs, tokens, or exploitable production details in a public issue. Use the repository owner's private security-reporting channel if one is configured; otherwise contact the maintainers privately before disclosing sensitive details.


## Public pages and SEO

The branch includes Persian server-rendered informational pages intended to make public service information easier for search engines to discover:

- `/about` — about MEKANIX
- `/services/heavy-machinery` — heavy-machinery repair and maintenance request guidance
- `/services/mobile-repair` — mobile repair request guidance

Page metadata, canonical paths, Open Graph previews, `robots.txt`, and `sitemap.xml` are maintained in the Next.js App Router. The pages avoid unverified claims about nationwide coverage, guaranteed arrival times, warranty duration, or live payment availability. SEO implementation and launch checks are documented in [docs/SEO_IMPLEMENTATION.md](docs/SEO_IMPLEMENTATION.md).

The canonical origin is configured as `https://mekanix.ir`; verify DNS/TLS and rendered metadata against the live domain before launch. Sitemap inclusion does not guarantee indexing or rankings.
