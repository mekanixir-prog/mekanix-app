# Dependency security patch — 2026-11-21

## Changes

- Upgrade `next` from 16.4.3 to 16.4.6.
- Pin transitive `effect` to 3.22.1 using Bun-supported package overrides.
- Regenerate `bun.lock` with Bun 1.4.4. Package integrity and optional SWC binaries are recorded by the lockfile generator; no integrity values were hand-edited.

## Security rationale

- The November 2026 Next.js advisories affect 16.x versions through 16.4.4; 16.4.5 is the first patched release. This patch uses 16.4.6.
- `effect` versions through 3.22.0 are affected by GHSA-7589-6fvf-x4pw (CVE-2026-121707), a ReDoS in `Schema.TemplateLiteral`. The fix is in 3.22.1.
- The prior locked tree reported eight Next.js advisories (one High and seven Moderate) and then one remaining High Effect advisory. Both dependency families are patched in this branch.

## Validation required

- `bun install --frozen-lockfile`
- `bun audit --audit-level=moderate`
- CI, TypeScript, lint, unit/integration tests
- PostgreSQL CI
- Docker E2E
- Cloudflare Build
- Production readiness
- CodeQL and Secret Scan

Do not lower the audit threshold. Do not mark this patch complete until the audit and required workflows pass on the same exact commit.

## Scope and safety

This is a dependency-only patch. It does not change business logic, financial records, D1/PostgreSQL data, production secrets, live SMS, payments, withdrawals, or deployment configuration.
