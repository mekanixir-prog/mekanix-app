# Next.js security patch — 2026-11-21

- Previous pinned version: Next.js 16.4.3.
- Selected patched release: Next.js 16.4.6.
- Upstream release tags verified in `vercel/next.js`: `v16.4.5` and `v16.4.6`.
- The November 2026 advisories affect Next.js 16.x through 16.4.4; the patched release line begins at 16.4.5.
- The lockfile must be regenerated with the repository-pinned Bun 1.4.4. Do not hand-edit package integrity or transitive dependency entries.
- Do not lower the `bun audit --audit-level=moderate` threshold to bypass known advisories.
- Required validation after lock refresh: CI, Production readiness, PostgreSQL CI, Docker E2E, Cloudflare Build, CodeQL and Secret Scan on the same exact commit.

This document records the dependency remediation intent; it does not claim that the upgrade or validation is complete.


The lockfile refresh workflow is now supplied by the PR target branch and will write the regenerated lockfile back to this PR head. It is temporary and must be removed after the lockfile is committed.
