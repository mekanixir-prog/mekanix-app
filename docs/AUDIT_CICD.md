# CI/CD & Deployment Readiness Audit — `mekanix-app`

**Task ID:** F-7
**Agent:** CI/CD & Deployment Engineer
**Scope:** `.github/workflows/*` (4 files), branch safety, Cloudflare build workflow gap, cache/artifact correctness, secret usage, deploy scripts, rollback runbook, post-release smoke tests.
**Working tree:** `feature/cloudflare-d1-validation @ 1cf59e7` + 29 modified tracked files (recovered UI — untouched). Local HEAD on `main @ 23b71d2`.
**Constraints honored:** READ-ONLY on all source + workflows. No `.github/workflows/*` created/edited (proposed only). No deploy/staging scripts executed. No `wrangler deploy`, no push, no secret changes. Dev server on :3000 left running.

---

## 1. Executive Summary

The repository ships **4 GitHub Actions workflows** (`ci.yml`, `docker-e2e.yml`, `postgresql-ci.yml`, `production-readiness.yml`). All four target the **Node/Docker/PostgreSQL** build path. **None of them exercise the Cloudflare Workers build** (`bash scripts/build-cloudflare.sh` + `bunx opennextjs-cloudflare build`) — which is the entire purpose of PR #3 (`feature/cloudflare-d1-validation`). This is the single most important CI/CD gap and is tracked as **CI-01 (High)**.

Trigger config is uniformly `push: [main]` + `pull_request: [main]` (plus `hardening/**` push on `production-readiness.yml`). A **PR opened against `main`** (such as PR #3) **does run all four workflows**. A **direct push to `feature/cloudflare-d1-validation` runs nothing** — there is no feature-branch push trigger (CI-02, Medium). No workflow pushes/merges code, so `main` **cannot receive unattended changes** from CI; branch safety is otherwise sound.

Cache/artifact hygiene is weak: no `actions/cache`, no Docker layer cache, no Playwright browser cache, no Prisma/Next cache, no `upload-artifact` (CI-05/CI-06). `bun-version: latest` floats in 3 workflows (CI-03, non-reproducible). Playwright E2E tests (`test:e2e`) are defined but **never run in CI** (CI-07). No `secrets.*` are referenced anywhere; all CI env values are hardcoded test credentials, so there is **no secret-leak surface in workflows** (CI-14).

Deploy scripts (`deploy.sh`, `deploy-staging.sh`) are Docker/PostgreSQL-local-deploy paths only — they do **not** push/merge/remote-deploy and gate on required env vars. There is **no Cloudflare deployment automation** at all (CI-12); Worker deploy is a manual `wrangler deploy`. Rollback is therefore `wrangler deployments rollback` for the Worker and D1-backup-restore for schema changes (runbook in §8).

**Live GitHub run status: NOT VERIFIED** (no GitHub credentials in this env). Inference from local evidence is in §5.

**Findings:** 0 Critical · 1 High · 5 Medium · 6 Low · 2 Info (14 total). No deploy blockers beyond CI-01 (untested CF build) — and even CI-01 is a *coverage* gap, not a breakage: prior agent B-2 confirmed the CF build exits 0 locally (`docs/AUDIT_CLOUDFLARE_BUILD.md`).

---

## 2. Workflow Inventory Table

| # | File | Trigger (`on:`) | Jobs (runner / timeout) | Key steps | Covers | Secrets used (names) |
|---|------|-----------------|-------------------------|-----------|--------|------------------------|
| 1 | `.github/workflows/ci.yml` | `push: [main]`, `pull_request: [main]` | `check` — Lint+TypeCheck+Test (`ubuntu-latest`, 15m) | checkout, setup-bun@v2 (latest), `bun install --frozen-lockfile`, `bunx prisma generate`, `check-hygiene.sh`, `bun run lint`, `bunx tsc --noEmit`, `bun run test` (DATABASE_URL=file:./test.db) | **Standard Node build** (lint/type/test) | none |
| 2 | `.github/workflows/docker-e2e.yml` | `push: [main]`, `pull_request: [main]` | `docker-deploy-test` — Docker Build+Compose+Health (`ubuntu-latest`, 30m) | checkout, docker buildx@v1, prepare PG build context (rsync→/tmp, swap migrations, `sed` provider sqlite→postgresql), `docker compose up -d --build`, health-loop on :3000/api/health (90×2s), assert PG healthy, OTP send smoke, `compose down -v` (always) | **Standard Node/Docker build (PostgreSQL provider)** | none (env: `DB_PASSWORD=test_password`, `JWT_SECRET=test_secret_for_ci` — hardcoded test values, not secrets) |
| 3 | `.github/workflows/postgresql-ci.yml` | `push: [main]`, `pull_request: [main]` | `postgres-test` — PG Migration+Build (`ubuntu-latest`, 20m) | service `postgres:16-alpine`; checkout, setup-bun@v2 (latest), install, `sed` provider→postgresql, replace migrations dir, `prisma generate`, `prisma migrate deploy`, `tsc --noEmit`, `bun run test`, `bun run build` (all with DATABASE_URL=postgresql://mekanix:mekanix_test@localhost:5432/mekanix_test) | **Standard Node build (PostgreSQL provider, real DB)** | none (hardcoded test DB creds) |
| 4 | `.github/workflows/production-readiness.yml` | `pull_request: [main]`, `push: [main, "hardening/**"]` | `quality` (`ubuntu-latest`, 20m) | checkout, setup-bun@v2 (latest), install, prisma generate, check-hygiene, eslint, tsc, `bun run test`, `security-audit.sh`, `bun run build` (DATABASE_URL=file:./test.db) | **Standard Node build + repo/security gates** | none |

**Coverage summary:** (a) Standard Node/Docker build → covered by **all four** (ci.yml lints, docker-e2e.yml builds Docker+PG, postgresql-ci.yml builds against real PG, production-readiness.yml adds security-audit). (b) **Cloudflare Workers build → covered by ZERO workflows.** This is the gap (§4).

**Matrix:** none used. **Cache:** none configured (no `actions/cache`, no `setup-bun` cache key, no Docker layer cache). **Artifacts:** none uploaded. **Env:** only test/literal values; no `secrets.*`.

---

## 3. Branch Safety Analysis

**Question 1 — Can `feature/cloudflare-d1-validation` auto-merge/push to `main`?**
**No.** No workflow contains `git push`, `git merge`, `gh pr merge`, `create-pull-request`, or any `permissions: contents: write` step (grep of `.github/` for `git push|git merge|create-pull-request|gh pr|permissions:` → 0 matches). The only mutation of `main` in the repo happens via **interactive** bootstrap scripts (`connect-github.sh:84`, `setup-ci.sh:76`), which require a human to paste a PAT at a `read -s` prompt — they cannot run inside a GitHub Actions job.

**Question 2 — Can `main` receive unattended changes from these workflows?**
**No.** Per-workflow:

| Workflow | Push to main? | Merge to main? | Deploy/remote write? | Verdict |
|----------|:---:|:---:|:---:|---------|
| ci.yml | ✗ | ✗ | ✗ | safe |
| docker-e2e.yml | ✗ | ✗ | ✗ (local docker compose only) | safe |
| postgresql-ci.yml | ✗ | ✗ | ✗ (migrations applied to ephemeral PG service, not prod) | safe |
| production-readiness.yml | ✗ | ✗ | ✗ | safe |

`production-readiness.yml` adds a `push: ["hardening/**"]` trigger — this only causes the workflow to *run* on pushes to a `hardening/*` branch; it does **not** write to `main`. No risk.

**Question 3 — Does a push/PR on `feature/cloudflare-d1-validation` run CI?**
- **PR (feature/cloudflare-d1-validation → main): YES** — all four workflows fire (`pull_request: branches: [main]`). This is how PR #3 gets CI.
- **Direct push to `feature/cloudflare-d1-validation`: NO** — none of the four `push:` triggers include the feature branch (all are `branches: [main]` only, plus `hardening/**` on #4). Broken commits on the feature branch are not caught until the PR is opened/updated. → **CI-02 (Medium).**

**Branch state (local evidence):**
- Local `main` @ `23b71d2`; `feature/cloudflare-d1-validation` @ `1cf59e7` ("fix(sec): validate payment status in admin PATCH route").
- `git merge-base --is-ancestor 1cf59e7 main` → **NOT an ancestor**: the feature tip has **not** been merged into local `main`. PR #3 is still open/unmerged. ✅ consistent with "do not merge feature→main unattended."
- Two GitHub remotes are configured (CI-13): `origin` = `s6beheshti/mekanix`, `new-repo` = `mekanixir-prog/mekanix-app`. `feature/cloudflare-d1-validation` exists on `new-repo` only → **PR #3 lives on `mekanixir-prog/mekanix-app`**.

---

## 4. Cloudflare Build Workflow Gap + Proposed Workflow

### 4.1 The gap

There is **no dedicated workflow** that runs `bash scripts/build-cloudflare.sh` (which internally calls `bunx opennextjs-cloudflare build`) on PRs. The CF build — the entire deliverable of PR #3 — is therefore **unvalidated by CI on every PR update**. Prior agent B-2 verified it passes locally once (`docs/AUDIT_CLOUDFLARE_BUILD.md`, exit 0, ~95s), but that is a point-in-time manual check, not a continuous gate. → **CI-01 (High).**

### 4.2 Proposed workflow (for Agent 1 to review/place at `.github/workflows/cloudflare-build.yml`)

> Not created here — shared-file change coordinated by Agent 1. YAML below is ready to drop in.

```yaml
name: Cloudflare Build

# Validates the Cloudflare Workers build path on every PR targeting main
# and on direct pushes to the feature branch. Does NOT deploy.
on:
  pull_request:
    branches: [main]
    paths:
      - 'scripts/build-cloudflare.sh'
      - 'scripts/cf-pages-fix.sh'
      - 'next.config.worker.ts'
      - 'next.config.ts'
      - 'open-next.config.ts'
      - 'wrangler.toml'
      - 'src/lib/db.worker.ts'
      - 'src/lib/db-worker.ts'
      - 'src/lib/db-access.ts'
      - 'prisma/**'
      - 'package.json'
      - 'bun.lock'
      - '.github/workflows/cloudflare-build.yml'
  push:
    branches:
      - main
      - 'feature/cloudflare-d1-validation'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: cf-build-${{ github.ref }}
  cancel-in-progress: true

jobs:
  cloudflare-build:
    name: OpenNext → Cloudflare Worker
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun (pinned)
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.4'   # pin for reproducibility (see CI-03)
          cache: true             # cache bun store keyed on bun.lock

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build Cloudflare Worker
        env:
          DATABASE_URL: 'file:./db/custom.db'
        run: bash scripts/build-cloudflare.sh
        # build-cloudflare.sh handles: schema engineType swap, next.config.worker swap,
        # db.worker.ts swap, prisma generate, OpenNext build, and trap-based restore.

      - name: Verify Worker artifact
        run: |
          test -f .open-next/worker.js         || { echo 'worker.js missing'; exit 1; }
          test -d .open-next/assets             || { echo 'assets dir missing'; exit 1; }
          test -f .open-next/server-functions/default/handler.mjs || { echo 'handler.mjs missing'; exit 1; }
          echo "Worker artifact size: $(du -sh .open-next/worker.js | cut -f1)"

      - name: Assert no untracked source mutation leaked
        run: |
          # build-cloudflare.sh restores schema/next.config/db.ts via trap.
          # Fail if any backup file survived.
          ! [ -f prisma/schema.prisma.bak ] || { echo 'schema backup leaked'; exit 1; }
          ! [ -f next.config.ts.bak ]       || { echo 'next.config backup leaked'; exit 1; }
          ! [ -f src/lib/db.ts.bak ]        || { echo 'db.ts backup leaked'; exit 1; }

      - name: Upload Worker artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: opennext-worker-${{ github.sha }}
          path: |
            .open-next/worker.js
            .open-next/server-functions/default/handler.mjs
            .open-next/assets
          if-no-files-found: warn
          retention-days: 7
```

**Design notes for Agent 1:**
1. **No deploy step** — strictly build+verify+artifact. Deploy is a separate gated action (manual `wrangler deploy`, §8).
2. **`paths` filter** avoids running on doc-only changes.
3. **Pinned Bun `1.3.4`** matches `devDependencies.bun-types ^1.3.4` (fixes CI-03 for this workflow).
4. **`concurrency`** cancels superseded runs on the same ref.
5. **Backup-leak assertion** turns the build-cloudflare.sh trap-restore contract (agent B-2 finding CF-04) into a hard CI gate.
6. **No secrets required** — the CF build is fully offline (`DATABASE_URL=file:./db/custom.db`).
7. After Agent 1 lands this, consider extending `ci.yml` push trigger to `feature/cloudflare-d1-validation` so the *standard* lint/type/test also run on feature pushes (CI-02).

---

## 5. Live CI Status

> **Live GitHub run status: NOT VERIFIED (no GitHub credentials in this env).**
> The following is **inference from local evidence only** — not a claim of green/red on GitHub.

| Signal | Source | Inference |
|--------|--------|-----------|
| Workflow trigger config | the 4 `.yml` files | PR #3 (`feature/cloudflare-d1-validation` → `main`) **would trigger** all 4 workflows (pull_request: [main]). Direct pushes to the feature branch trigger none. |
| Canonical PR repo | `git remote -v` + `git branch -a` | PR #3 is on `new-repo` = `mekanixir-prog/mekanix-app` (only remote carrying `feature/cloudflare-d1-validation`). `origin` (`s6beheshti/mekanix`) does **not** have the feature branch. |
| CI fix history | `new-repo/main @ e4c2faf` ("fix(ci): resolve ESLint + TypeScript errors blocking all 4 CI workflows (#1)") | All 4 workflows are present on `new-repo/main` and were previously **failing** (ESLint+TS), then **fixed** via PR #1. Implies CI infra is live and green-capable on `new-repo`. |
| Feature tip | `feature/cloudflare-d1-validation @ 1cf59e7` | Not an ancestor of local `main` → PR #3 not merged. |
| Local CI artifacts | `playwright-report/`, `test-results/`, `coverage/` → **absent**; `.next/` (452M) + `.open-next/` (180M) present from local builds | No cached run results; `.open-next/` is from agent B-2's local CF build, not from CI. |
| Working tree | `git status --short` = 36 entries (29 recovered-UI + docs edits by prior agents) | The committed branch tip (`1cf59e7`) is what CI tests; the **29 working-tree modifications are NOT in CI** (uncommitted). |

**Bottom line (inferred, not verified):** On `new-repo`, PR #3 almost certainly ran the 4 workflows on its last push; whether they are currently green is **unknown without GitHub access**. Regardless of their status, **none of them tests the Cloudflare build**, so even a fully-green PR #3 does not validate the CF path. Recommend merging the proposed `cloudflare-build.yml` (§4) before approving PR #3.

---

## 6. Cache / Artifact Correctness

| Concern | Present? | Detail | Verdict |
|---------|:---:|--------|---------|
| `node_modules` / Bun store cache | ✗ | `setup-bun@v2` is used but **no `cache:` input** and **no `actions/cache`** step. (setup-bun@v2 *can* auto-cache when a lockfile is detected, but it is not explicitly enabled and there is no observable cache key.) | **Gap — CI-05** |
| `bun.lock` lockfile cache | ✗ | Same as above; no explicit key on `bun.lock`. | **Gap — CI-05** |
| Playwright browser cache | n/a | No workflow runs `test:e2e` / installs Playwright browsers. Cache question is moot **because E2E never runs** (CI-07). | **Gap — CI-07** |
| Prisma generate cache | ✗ | Regenerated every run (`bunx prisma generate`). Fast, but uncached; output not artifact-pinned. | Minor — CI-05 |
| Next.js `.next` build cache | ✗ | No `actions/cache` on `.next/cache`. `bun run build` cold each run. | CI-05 |
| Docker layer cache | ✗ | `docker-e2e.yml:22` uses `docker/setup-buildx-action@v1` with **no `cache-from`/`cache-to`** → full rebuild every run (slowest job). | CI-05 |
| Build artifacts (`upload-artifact`) | ✗ | Zero `upload-artifact` across all 4 workflows. `.next/standalone`, `.open-next/worker.js`, Docker images are discarded → cannot inspect failures or fetch Worker for deploy. | **Gap — CI-06** |
| Matrix | ✗ | None. Single Bun version, single Node path. | acceptable |

**Correctness (not just presence):** the lockfile approach (`bun install --frozen-lockfile` + `bun.lock` present) is **correct** — CI will fail fast on lockfile drift. `bun-version: latest` (ci.yml:21, postgresql-ci.yml:36, production-readiness.yml:17) is the one correctness defect: a floating toolchain can break CI overnight without a code change (CI-03).

---

## 7. Secret Usage

| Secret name | Workflow | Purpose | Echoed into logs? |
|-------------|----------|---------|:---:|
| *(none)* | ci.yml | — | n/a |
| *(none)* | docker-e2e.yml | — | n/a |
| *(none)* | postgresql-ci.yml | — | n/a |
| *(none)* | production-readiness.yml | — | n/a |

**There are zero `secrets.*` references in any workflow** (grep `.github/` for `secrets\.` → no matches). All CI env values are **hardcoded test literals**:

| Workflow | Env var | Value | Risk |
|----------|---------|-------|------|
| docker-e2e.yml:15-16 | `DB_PASSWORD`, `JWT_SECRET` | `test_password`, `test_secret_for_ci` | None — test-only, never real secrets. Visible in file is acceptable. |
| postgresql-ci.yml:60,65,70,75,80 | `DATABASE_URL` | `postgresql://mekanix:mekanix_test@...` | None — ephemeral CI service DB. |
| ci.yml:41, production-readiness.yml:33 | `DATABASE_URL` | `file:./test.db` | None — local file DB. |

**Deploy scripts** (`deploy.sh`, `deploy-staging.sh`) read `DB_PASSWORD`/`JWT_SECRET`/`REDIS_PASSWORD` from the **runtime environment** (`deploy.sh:27-36`, `deploy-staging.sh:18-20` via `${VAR:?}`) — they are **never written to logs, never embedded in the build context**, and the build context is a `mktemp` dir cleaned by trap. ✅ Correct secret handling at deploy time. No secret is echoed.

> Note: `connect-github.sh:91` writes a GitHub PAT to `~/.git-credentials` in **plaintext** and embeds it in the remote URL (line 81) before scrubbing (line 87). This is a **dev-machine** concern (CI-09), not a workflow secret — and it is interactive.

---

## 8. Deploy Scripts Audit

### 8.1 `scripts/deploy.sh` (production, Docker/PostgreSQL path)
- **What it does:** validates env → `mktemp` build context → rsync repo (excluding node_modules/.next/.git/db) → swap SQLite migrations for PostgreSQL (`rm -rf migrations`, `cp` PG migration + lock, `sed` provider→postgresql) → `docker compose up -d --build` → health-loop on :3000/api/health (60×2s=120s).
- **Gates:** requires `DB_PASSWORD` + `JWT_SECRET` (exits 1 if missing). No `--prod` confirmation prompt, no dry-run flag.
- **Safety:** ✅ does **not** mutate the developer working tree (all swaps in temp ctx, `trap rm -rf` on exit). ✅ no `git push`/merge/remote deploy. ✅ no secrets in build context.
- **Rollback path:** ❌ none in-script. Manual: `docker compose down`, then redeploy previous image (`git checkout <prev-tag>` + rebuild, or pull a pre-tagged image).
- **Bug:** duplicate `JWT_SECRET` check (lines 31-36 echo "❌ JWT_SECRET not set" twice and set `MISSING=1` twice). Harmless to outcome but sloppy → **CI-10**.

### 8.2 `scripts/deploy-staging.sh` (staging, Docker/PostgreSQL path)
- **What it does:** stricter env validation (`: "${DB_PASSWORD:?...}"`, `JWT_SECRET`, `REDIS_PASSWORD` — no fallbacks) → temp build ctx → PG migration swap → `docker compose -f docker-compose.staging.yml up -d --build` → health-loop on **:3001** (`/api/health` + `/api/ready`).
- **Gates:** 3 required env vars, fail-fast. ✅
- **Safety:** ✅ no working-tree mutation, ✅ no push/merge/remote deploy, ✅ secrets from env only.
- **Rollback path:** ❌ none in-script; manual `docker compose -f docker-compose.staging.yml down` + redeploy.

### 8.3 `scripts/cf-pages-fix.sh` (Cloudflare **Pages** post-build fixup)
- **What it does:** if `.open-next/worker.js` exists, copies it to `_worker.js` (Pages expects `_worker.js`); copies `.open-next/assets/*` to `.open-next/` root.
- **Gates:** none (idempotent, `set -e`).
- **Safety:** ✅ no deploy, no push.
- **Concern:** this targets **Cloudflare Pages**, but `wrangler.toml` is configured for **Cloudflare Workers** (`main = ".open-next/worker.js"`, `[assets] directory = ".open-next/assets"`). Two deploy targets are implied but only Workers is wired → **CI-11**. Decide one: if Workers (per wrangler.toml), mark this script unused; if Pages, add a Pages config and update wrangler.toml.

### 8.4 `connect-github.sh` (interactive dev bootstrap — NOT a CI auth helper)
- **Purpose:** one-time helper to create a GitHub repo and push local `main` to it. Reads a PAT interactively (`read -s`), calls `POST /user/repos`, adds remote with PAT embedded in URL, `git push -u origin main`, scrubs token from remote URL, stores PAT in `~/.git-credentials` (chmod 600).
- **Not a CI auth helper** despite its name suggesting "connection." It runs **interactively only** (multiple `read` prompts) → cannot execute inside a GHA job.
- **Safety concerns:** pushes **directly to `main`** (line 84); stores PAT in **plaintext** at `~/.git-credentials` (line 91). → **CI-09 (Low).** Recommend `gh auth login` or OS-keychain credential helper; avoid main-direct push.

### 8.5 `scripts/setup-ci.sh` (interactive CI bootstrap)
- **Purpose:** pushes `ci.yml` + `production-readiness.yml` (only) to GitHub via Contents API, to branch `main`, on repo `s6beheshti/mekanix` (hardcoded `GH_USER="s6beheshti"`). Requires PAT with `workflow` scope.
- **Gaps:** (a) pushes only **2 of 4** workflows — omits `docker-e2e.yml` + `postgresql-ci.yml`; (b) targets `origin` repo, while PR #3 lives on `new-repo`; (c) writes to `main` via API (interactive, so acceptable, but inconsistent with the actual PR repo). → **CI-08 (Low).**

---

## 9. Rollback Runbook

### 9.1 Cloudflare Worker rollback (primary target of PR #3)

**Scenario:** a bad Worker version was deployed via `wrangler deploy`.

```bash
# 1. List recent deployments (Cloudflare keeps version history)
bunx wrangler deployments list

# 2. Roll back to the immediately-previous version (instant, no rebuild)
bunx wrangler deployments rollback
#    ↑ redeploys the previous Worker version; traffic cuts over in seconds.

# 3. If rollback is insufficient (e.g. bad code in BOTH versions),
#    redeploy a known-good build from a pinned commit:
git checkout <known-good-sha>
bash scripts/build-cloudflare.sh
bunx wrangler deploy
```

**D1 migration rollback (schema changes):**

D1 migrations applied via `prisma migrate deploy` (with `@prisma/adapter-d1`) are **forward-only** in practice. Safe rollback:

```bash
# BEFORE any new migration in production, always snapshot D1:
bunx wrangler d1 backup create mekanix      # database_name from wrangler.toml [[d1_databases]]

# To roll back a bad migration:
bunx wrangler d1 backup restore <backup-id> mekanix
# ⚠️ This restores DB to the backup point — ALL writes since the backup are LOST.
#    Coordinate with a maintenance window / announce data loss.
```

**Mitigation rules (design-time):**
- Ship only **additive** migrations in PR #3 (new tables/columns, never `DROP`/`ALTER` of in-use columns). The D1 audit (agent B-3, `docs/AUDIT_D1_PRISMA.md`) found `RateLimit` + `IdempotencyKey` **missing from the D1 migration** (D1-01 Critical) — adding them is additive and safe; do that before merge.
- Never ship a column rename or type change in a single migration; split into add→backfill→(later)drop across two releases.
- `prisma migrate resolve --rolled-back` is only for **failed** migrations, not applied ones.

### 9.2 Docker/PostgreSQL rollback (`deploy.sh` path)

```bash
# 1. Stop the bad stack (keeps volumes → data preserved)
docker compose down

# 2. Roll back the image:
#    Option A — previous tag:
docker compose pull && docker compose up -d    # if registry has prev tag
#    Option B — rebuild from previous commit:
git checkout <prev-release-tag>
bash scripts/deploy.sh   # DB_PASSWORD=... JWT_SECRET=...

# 3. Roll back PG schema (if a bad migration was applied):
pg_restore -d mekanix <pre-deploy.dump>        # from pg_dump taken before deploy
bunx prisma migrate resolve --rolled-back <bad-migration-name>  # only if it FAILED mid-apply
```

---

## 10. Post-Release Smoke Test Checklist

Run these against the deployed Worker URL (`https://<worker>.workers.dev` or custom domain) immediately after `wrangler deploy`:

| # | Method | Endpoint | Expected | What it proves |
|---|--------|----------|----------|----------------|
| 1 | GET | `/api/health` | `{"ok":true,"services":{"database":"healthy",...}}` | Worker boots, D1 binding live |
| 2 | GET | `/api/ready` | 200, ready | Readiness probe (uses `SELECT 1` via `$queryRaw`) |
| 3 | POST | `/api/auth/otp/send` body `{"phone":"+989121234567"}` | `{"ok":true}` | OTP send path; with `SMS_PROVIDER=console` (wrangler.toml:17) code prints to logs — verify in `wrangler tail` |
| 4 | GET | `/api/services` | 200, list | Public read path works end-to-end through OpenNext |
| 5 | GET | `/api/payments` | **404** | `PAYMENT_PROVIDER=simulator` + `NODE_ENV=production` (wrangler.toml:17-19) → all 5 payment routes hard-404. **Confirms no real money can move.** |
| 6 | GET | `/api/vip/plans` | 200, list | VIP read path |
| 7 | GET | `/api/invoices` | 401 (no session) | Auth gate enforced (not 500) |
| 8 | GET | `/api/admin/customers` | 401 (user JWT must NOT pass) | Regression guard for **SEC-21** (agent B-4 Critical) — a *user* JWT must not reach admin routes in prod |
| 9 | — | `wrangler tail` | no uncaught exceptions during 1-8 | Runtime health |
| 10 | GET | `https://<worker>/mekanix-source.tar.gz` | **404** | Confirms agent B-2 finding **CF-01** (public source-tarball leak) was remediated before deploy |

If any of #5 (payments 404), #8 (admin 401), #10 (tarball 404) fail, **halt rollout and rollback per §9.1.**

---

## 11. Findings Table

| ID | File:line | Severity | Description | Repro / Evidence | Status | Fix |
|----|-----------|----------|-------------|-------------------|--------|-----|
| CI-01 | `.github/workflows/` (absence) | **High** | No workflow exercises the Cloudflare Workers build (`build-cloudflare.sh` + `opennextjs-cloudflare build`). The defining deliverable of PR #3 is unvalidated by CI. | `rg "build-cloudflare\|opennextjs-cloudflare" .github/` → 0 hits | Open | Add `cloudflare-build.yml` (§4.2); gate PR #3 on it |
| CI-02 | `ci.yml:4-7` (also docker-e2e/postgresql-ci/production-readiness `on:`) | Medium | No `push:` trigger on `feature/cloudflare-d1-validation` (or `feature/**`). Direct pushes to the feature branch run zero CI; broken builds detected only after PR open. | `git log` of feature tip vs. workflow `on.push.branches` | Open | Add `feature/cloudflare-d1-validation` (or `feature/**`) to `push.branches` in ci.yml + proposed CF workflow |
| CI-03 | `ci.yml:21`, `postgresql-ci.yml:36`, `production-readiness.yml:17` | Medium | `bun-version: latest` floats the toolchain — non-reproducible; an upstream Bun release can break CI with no code change. | `rg "bun-version" .github/` | Open | Pin to a concrete version (e.g. `1.3.4`, matches `bun-types` devDep) |
| CI-04 | all 4 workflows (no `permissions:` block) | Low | No explicit `permissions:` → inherits repo-default GITHUB_TOKEN scope. Defense-in-depth gap (no push steps today, so low actual risk). | `rg "^permissions:" .github/` → 0 | Open | Add `permissions: contents: read` to each workflow |
| CI-05 | `ci.yml`, `docker-e2e.yml:22`, `postgresql-ci.yml`, `production-readiness.yml` | Medium | No caching anywhere: no `actions/cache`, no `setup-bun` cache key, no Docker layer cache (`setup-buildx-action@v1` w/o `cache-from/cache-to`), no `.next` cache, no Prisma generate cache. Cold builds every run. | `rg "actions/cache\|cache-from\|cache-to" .github/` → 0 | Open | Enable `setup-bun` cache, add `actions/cache` for `.next/cache`, add Docker `cache-to` |
| CI-06 | all 4 workflows | Medium | Zero `upload-artifact`. Build outputs (`.next/standalone`, `.open-next/worker.js`, Docker image) discarded → cannot inspect failures or fetch Worker for deploy. | `rg "upload-artifact" .github/` → 0 | Open | Upload worker artifact in proposed CF workflow; upload `.next` build logs `if: failure()` |
| CI-07 | `package.json:18` vs. all workflows | Medium | Playwright E2E (`test:e2e`) is defined but **never run in any CI workflow**. No `bun run test:e2e`, no browser install/cache. E2E coverage = 0 in CI. | `rg "test:e2e\|playwright" .github/` → 0 | Open | Add dedicated `e2e.yml` with `playwright` browser cache + service containers |
| CI-08 | `setup-ci.sh:51-52,70-86` | Low | Pushes only `ci.yml` + `production-readiness.yml` (omits `docker-e2e.yml`, `postgresql-ci.yml`) to hardcoded repo `s6beheshti/mekanix` (origin), while PR #3 lives on `mekanixir-prog/mekanix-app` (new-repo). | `git remote -v`; `setup-ci.sh:51 GH_USER="s6beheshti"` | Open | Either push all 4 via `git`, or update script to target the canonical repo + all 4 files |
| CI-09 | `connect-github.sh:84,91` | Low | Pushes directly to `main` (line 84) and stores GitHub PAT in plaintext `~/.git-credentials` (line 91). Interactive only, so not a CI risk, but insecure on shared hosts. | `connect-github.sh:84,91` | Open | Use `gh auth login` / OS keychain; never push to main directly |
| CI-10 | `deploy.sh:31-36` | Low | Duplicate `JWT_SECRET` validation block — echoes "❌ JWT_SECRET not set" twice and sets `MISSING=1` twice. Harmless to outcome. | `deploy.sh:31-36` | Open | Remove duplicate lines 34-35 |
| CI-11 | `cf-pages-fix.sh:7-8` vs. `wrangler.toml:5,8` | Low | `cf-pages-fix.sh` renames `worker.js`→`_worker.js` for **Cloudflare Pages**, but `wrangler.toml` is wired for **Workers** (`main=".open-next/worker.js"`, `[assets] directory=".open-next/assets"`). Two deploy targets implied; only Workers configured. | `cf-pages-fix.sh:7`; `wrangler.toml:5-9` | Open | Pick one target; if Workers, mark script unused; if Pages, add Pages config + update wrangler.toml |
| CI-12 | (absence) | Low | No `wrangler deploy` / Cloudflare deployment automation in any workflow or script. Worker deploy is fully manual. | `rg "wrangler deploy" .github/ scripts/` → 0 | Open (by design) | Acceptable as a deploy gate; document manual deploy in runbook (§9). Add a separate gated `deploy.yml` later if desired |
| CI-13 | `git remote -v` | Info | Two remotes configured: `origin` (s6beheshti/mekanix) and `new-repo` (mekanixir-prog/mekanix-app). `feature/cloudflare-d1-validation` exists only on `new-repo` → PR #3 is on `new-repo`. CI trigger behavior depends on which repo's `main` carries the workflow files. | `git branch -a` | Info | Document canonical repo = `mekanixir-prog/mekanix-app`; archive or repoint `origin` |
| CI-14 | all 4 workflows | Info | Zero `secrets.*` references. All CI env values are hardcoded test literals (`test_password`, `test_secret_for_ci`, `mekanix:mekanix_test`, `file:./test.db`). No secret-leak surface in workflows. Deploy scripts read secrets from runtime env only. | `rg "secrets\." .github/` → 0 | Info (good) | None needed — maintain discipline when adding deploy workflows |

**Totals:** 0 Critical · 1 High · 5 Medium · 6 Low · 2 Info = **14 findings**

**Top blockers for PR #3 approval:** CI-01 (no CF build gate) is the only High. CI-02/03/05/06/07 are quality issues that should follow but are not hard blockers given agent B-2's local green build. Coordinate the new `cloudflare-build.yml` with **Agent 1** (shared-file owner).

---

*End of report — F-7 / CI/CD & Deployment Engineer.*
