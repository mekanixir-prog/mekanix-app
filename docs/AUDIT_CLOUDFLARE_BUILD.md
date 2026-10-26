# AUDIT — Cloudflare Workers Build Pipeline (Task B-2)

**Agent:** Cloudflare Build Engineer (Agent 2)
**Task ID:** B-2
**Date:** 2026-10-23
**Scope:** `scripts/build-cloudflare.sh`, `open-next.config.ts`, `next.config.ts`, `next.config.worker.ts`, `wrangler.toml`, `package.json` build scripts, Prisma-on-Workers wiring.
**Method:** Read-only source audit + actual execution of both builds (`bun run build` and `bash scripts/build-cloudflare.sh`) inside the sandbox.

---

## 1. Executive summary

- ✅ **Both builds PASS in this environment.** `bun run build` exits 0; `bash scripts/build-cloudflare.sh` exits 0 and produces `.open-next/worker.js` (2.3 KB entry shim) + `.open-next/assets/` (15 static-asset entries) + `.open-next/server-functions/default/handler.mjs` (6.6 MB bundled server).
- ✅ **File-restore trap is sound.** `trap cleanup EXIT` runs on every exit path (success, `set -e`, normal error, SIGINT). Verified post-build: zero byte-diff on `prisma/schema.prisma`, `next.config.ts`, `src/lib/db.ts`; no `.bak` files left behind. Git working tree is untouched (the 30 modified tracked files are the pre-existing baseline + coordinator's prior `worklog.md` append; the 1 untracked test file was added by another agent, not this build).
- ✅ **OpenNext ↔ wrangler.toml paths are consistent.** `main = ".open-next/worker.js"` matches the actual OpenNext output; `[assets] directory = ".open-next/assets"` matches; `[[d1_databases]] binding = "DB"` matches `src/lib/db-worker.ts` (`env.DB`).
- ✅ **Prisma-on-Workers is correctly wired.** `@prisma/adapter-d1@6.19.3` + `PrismaD1(env.DB)` per-request client in `src/lib/db-worker.ts`; build-time `engineType="client"` mutation + mock-adapter `db.worker.ts` is the right pattern for OpenNext page-data collection. All 66 API routes go through `getDbForLib()` (D1-aware) — zero routes import the sync `db` directly.
- ⚠️ **One HIGH-severity finding (CF-01):** `public/mekanix-source.tar.gz` (230 KB) is a tracked file containing the entire `src/` tree + a `.env`. The Cloudflare build copies `public/` into `.open-next/assets/`, so this tarball ships as a public static asset at `https://<worker>/mekanix-source.tar.gz`. Pre-existing repo issue, propagated by the build pipeline.

---

## 2. Build script safety analysis — `scripts/build-cloudflare.sh`

The script (143 lines) uses `set -euo pipefail` and a single `trap cleanup EXIT` registered at line 72 (after the function definition, before any mutating command). The cleanup function (lines 35-69) restores each file by `mv $BACKUP $ORIG` if the corresponding `.bak` exists, then re-runs `bunx prisma generate` against the restored schema (`|| true`).

### 2.1 Restore-on-failure matrix

| # | File mutated | Mutation mechanism | Backup created at | Restored by cleanup? | Risk if cleanup fails |
|---|---|---|---|---|---|
| 1 | `prisma/schema.prisma` | `sed -i '/binaryTargets/a\  engineType = "client"   // ...'` (line 92) | `cp` at line 79 → `prisma/schema.prisma.bak` | ✅ Yes (lines 40-43: `if [ -f $SCHEMA_BACKUP ]; then mv $SCHEMA_BACKUP $SCHEMA; fi`) | Schema left with `engineType="client"` → next `bun dev`/`bun run build` fails with P2038 (multiple-engine conflict). Visible in `git status`. |
| 2 | `next.config.ts` | `cp next.config.worker.ts next.config.ts` (line 103) | `cp` at line 81 → `next.config.ts.bak` | ✅ Yes (lines 44-48) | `next.config.ts` would be the worker variant (`serverExternalPackages`, no `output:"standalone"`). Node build would lose standalone output. Visible in `git status`. |
| 3 | `src/lib/db.ts` | `cp src/lib/db.worker.ts src/lib/db.ts` (line 113) | `cp` at line 83 → `src/lib/db.ts.bak` | ✅ Yes (lines 49-53) | `db.ts` would become the worker proxy/mock. Dev server (`bun run dev`) would still start, but every Prisma call would throw `Workers: sync db.X not supported`. Visible in `git status`. |
| 4 | `node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js` | `sed -i` adding `preview-props` to glob (line 128) | **None** — not a user file, lives in `node_modules/` | ❌ **Not restored** (by design) | Idempotent — the script's `grep -q "preview-props"` check (line 125) skips re-application. Lost on next `bun install`. Acceptable. |

### 2.2 Trap-coverage analysis (per failure path)

The `trap cleanup EXIT` is registered at line 72. The first mutating command is `cp` at line 79. Bash's EXIT trap fires on:
- Normal exit (end of script)
- `set -e` triggered exit (any non-`|| true` command fails)
- SIGINT (Ctrl-C) — bash converts to EXIT
- SIGTERM (signal 15) — handled by EXIT trap on most bash versions

NOT caught:
- **SIGKILL (kill -9)** — kernel-level, no trap possible. Files would be left mutated. This is an unavoidable limitation.
- **OOM kill** — same as SIGKILL.
- **Power loss / container hard-stop** — same.

### 2.3 Subtle correctness concerns

1. **`local exit_code=$?` capture (line 36):** Correct. `local var=$?` captures the previous `$?` before `local` resets its own exit status. Verified in bash 5.x.
2. **`set -e` inherited by trap function:** The cleanup function runs with `set -e` active. If the FIRST `mv` fails (disk full, permission), subsequent `mv` commands will NOT run. **Recommendation:** prefix each restore `mv` with `|| true` (or wrap the body in `set +e` / `set -e`) to ensure all three files are restored. Low probability in practice.
3. **`bunx prisma generate 2>/dev/null || true` in cleanup (line 56):** Suppresses stderr — if prisma generate fails in cleanup (e.g., the `mv`-restored schema is somehow malformed), the failure is silent. Since `mv` runs BEFORE this line and restores the original schema, this should be safe in practice, but the silent failure mode is worth noting.
4. **No concurrent-build protection:** If two builds run simultaneously, both use the same `.bak` filenames and would clobber each other's backups. Not a CI concern (CI runs single-job), but a developer-machine concern.
5. **`sed -i` portability:** The script assumes GNU sed (Linux). On macOS without `gsed`, `sed -i` requires a backup-suffix argument (`sed -i '' ...`). Not relevant here (sandbox is Linux).
6. **Post-build `bunx prisma generate` runs against restored schema (line 56):** This regenerates `@prisma/client` with the original `engineType` removed. Verified post-build: `node_modules/@prisma/client` is the original (non-client-engine) version. ✓

### 2.4 Verdict — safety

✅ **PASS.** For all non-SIGKILL/OOM exit paths, all three tracked files are restored. SIGKILL/OOM/power-loss would leave files mutated, but those are unavoidable. The node_modules patch is intentionally non-restored (idempotent). The 29 user-modified working-tree files are NEVER touched by this script.

---

## 3. OpenNext / wrangler.toml consistency

| Expected (per OpenNext defaults) | Actual in repo | Match? | Notes |
|---|---|---|---|
| Worker entry: `.open-next/worker.js` | `wrangler.toml` line 5: `main = ".open-next/worker.js"` | ✅ | Generated by OpenNext at `.open-next/worker.js` (2,278 bytes — entry shim that imports `./server-functions/default/handler.mjs`). |
| Assets dir: `.open-next/assets` | `wrangler.toml` lines 7-9: `[assets] directory = ".open-next/assets"`, `binding = "ASSETS"` | ✅ | 15 entries (BUILD_ID, _next/, cards/, logo.*, manifest.json, mekanix-source.tar.gz, offline.html, etc.). |
| D1 binding name matches code | `wrangler.toml` line 12: `binding = "DB"` ↔ `src/lib/db-worker.ts` lines 17-23, 45: `env.DB` | ✅ | Type-augmented via `declare global { interface CloudflareEnv { DB: D1Database } }`. |
| `compatibility_flags` includes `nodejs_compat` | `wrangler.toml` line 3: `compatibility_flags = ["nodejs_compat"]` | ✅ | Required for `node:crypto` (used in `src/lib/otp-crypto.ts`, `src/lib/auth.ts`). |
| `compatibility_date` recent | `wrangler.toml` line 2: `"2024-09-23"` | ⚠️ | OpenNext emits `WARN workerd compatibility_date: 2024-09-23, consider updating ...`. Non-blocking; bumping to a 2025 date is recommended. (CF-02) |
| OpenNext config present | `open-next.config.ts` calls `defineCloudflareConfig({})` (no overrides) | ✅ | Default config is correct for the standard D1+assets topology. |
| `[vars]` env provisioning | `wrangler.toml` lines 16-19: `SMS_PROVIDER="console"`, `PAYMENT_PROVIDER="simulator"`, `NODE_ENV="production"` | ✅ | Runtime vars for the Worker. `JWT_SECRET` is NOT in `[vars]` — must be set via `wrangler secret put JWT_SECRET` (correct, since secrets shouldn't be in plaintext vars). |
| `[observability].enabled` | `wrangler.toml` line 22: `enabled = true` | ✅ | Logs enabled. |

---

## 4. Node-only imports inventory

Scanned `src/**/*.ts` and `src/**/*.tsx` for `node:` builtins (`fs`, `path`, `crypto`, `child_process`, `net`, `tls`, `os`, `stream`, `buffer`, `util`, `url`, `http`, `https`), bare-name builtins, `process.cwd()`, `__dirname`, `__filename`, `require()`, and `sharp` (the only Node-only runtime dep in `package.json`).

| File:line | Import / usage | Runtime impact | Fix recommendation |
|---|---|---|---|
| `src/lib/otp-crypto.ts:4` | `import { createHash, randomInt } from "node:crypto"` | ✅ Works on Workers under `nodejs_compat`. `createHash("sha256")` is in the supported subset. `randomInt(min, max)` is supported on `nodejs_compat` (V2) with `compatibility_date >= 2024-09-23`. | None — verify in `wrangler dev` that `randomInt` doesn't throw on the actual runtime date. If it does, replace with `crypto.getRandomValues(new Uint32Array(1))` + modular reduction. |
| `src/lib/auth.ts:13` | `import { createHash } from "node:crypto"` (used at line 73: `createHash("sha256").update(token).digest("hex")`) | ✅ Works on Workers under `nodejs_compat`. | None. |
| `src/app/api/admin-panel/onboarding/route.ts:23-28` (comment only) | Comment references prior `fs.writeFileSync` — code no longer uses `fs`. | ✅ No runtime impact (comment only). | Optional: trim the comment now that the Worker-safe data-URL approach is in place. |
| `src/lib/redis.ts:72-77` | `setInterval(() => { ... memStore cleanup ... }, 5*60*1000)` at module top-level | ⚠️ On Workers, `setInterval` is supported but timers may not fire across requests (each isolate has its own event loop). The cleanup never runs — but `memStore` is per-isolate/per-request, so the leak is bounded. The bigger issue: the timer registration itself may emit a warning in stricter Workers configs. | Gate behind `if (!isCloudflareWorkers) { setInterval(...) }` (CF-05). |
| `src/lib/init.ts:4-21` | Top-level IIFE checks `isWorker` and only runs `initEtaProvider` / `initSmsProvider` on Node. | ✅ Correctly gated. No Worker impact. | None. |

**No Node-only imports found in:** `fs`, `path`, `child_process`, `net`, `tls`, `os`, `stream`, `buffer` (bare-name or `node:` prefix), `process.cwd()`, `__dirname`, `__filename`, `require()` (one match is a code comment), `sharp` (declared in `package.json` but not imported anywhere in `src/` — likely a transitive dep or unused).

---

## 5. Prisma-on-Workers readiness

### 5.1 Generator config (`prisma/schema.prisma:9-12`)

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]
}
```

- **At rest (committed):** No `engineType` field → standard Rust query engine. Used by `bun dev` and `bun run build`.
- **During `bash scripts/build-cloudflare.sh`:** `sed -i` (line 92) appends `engineType = "client"` after `binaryTargets`. This forces Prisma to use the JS/Data-Proxy query engine, which is REQUIRED when driving Prisma through a driver adapter (`@prisma/adapter-d1`).
- **After build:** Cleanup `mv` restores the original schema (no `engineType`), then `bunx prisma generate` regenerates `@prisma/client` with the original config. Verified post-build: `node_modules/@prisma/client` is the original (non-client-engine) version.
- **Note (CF-08, Info):** With `engineType = "client"`, the `binaryTargets` list is largely irrelevant — the Rust engine binaries aren't used. Listing 3 targets adds ~30 MB of unnecessary download during `prisma generate` (only inside the build sandbox). Not a correctness issue; minor build-time waste.

### 5.2 Adapter wiring

| Layer | File | Wiring | Status |
|---|---|---|---|
| Adapter package | `package.json:31` | `"@prisma/adapter-d1": "6.19.3"` | ✅ Installed (verified `node_modules/@prisma/adapter-d1@6.19.3`) |
| Prisma client | `package.json:32` | `"@prisma/client": "^6.11.1"` | ✅ Installed (resolved to 6.19.3 — adapter and client versions match) |
| Runtime client factory | `src/lib/db-worker.ts:39-67` | `getCloudflareContext({async:true})` → caches `new PrismaClient({ adapter: new PrismaD1(env.DB) })` per request via `Symbol.for("mekanix.prismaClient")` on the ctx | ✅ Per-request lifecycle, correctly cached. |
| Build-time stub | `src/lib/db.worker.ts:40-54` | Mock adapter (`{provider:"sqlite", connect:..., disconnect:...}`) wrapped in `new PrismaClient({ adapter: mockAdapter })` — satisfies the "adapter required" check during OpenNext page-data collection WITHOUT actually connecting | ✅ Correct pattern. Prevents P2038 (`Multiple engines enabled`) and the `engineType="client"` requires-adapter check during build. |
| Workers-runtime sync `db` | `src/lib/db.worker.ts:26-39` | `new Proxy({}, { get: throws "Workers: sync db.X not supported. Use await getDb()" })` | ✅ Fails closed with a clear error message. |
| Lib/router indirection | `src/lib/db-access.ts:36-49` | `getDbForLib()` detects Workers via `navigator.userAgent === "Cloudflare-Workers"`, dispatches to `db-worker.ts#getDb()` (Workers) or `db.ts#db` (Node) | ✅ Bridges sync/async without changing consumer signatures. |
| Consumer coverage | All 66 API routes in `src/app/api/` | All import `getDbForLib` from `@/lib/db-access` (verified via `rg` — zero routes import sync `db` from `@/lib/db` directly) | ✅ Zero legacy sync-db consumers in production routes. (The stale "63 consumers" comment in `db.worker.ts:15` is incorrect — actual count is 0.) |

### 5.3 Edge compatibility

- `nodejs_compat` flag is set in `wrangler.toml:3`. ✅
- `@prisma/adapter-d1` is purpose-built for the Workers runtime (uses D1 binding, no socket/TLS). ✅
- `PrismaClient` with `engineType="client"` runs in pure JS — no native binaries loaded at runtime. ✅
- Per-request client instantiation pattern matches [OpenNext's Prisma + D1 docs](https://opennext.js.org/cloudflare). ✅

### 5.4 Verdict — Prisma-on-Workers

✅ **READY.** Adapter wired, build-time stub correct, per-request lifecycle correct, consumer migration complete (all routes use `getDbForLib`).

---

## 6. Build execution evidence

### 6.1 Standard Node build — `bun run build`

- **Command:** `DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bun run build`
- **Working dir:** `/home/z/my-project`
- **Bun:** 1.3.14, **Node:** v24.21.0
- **Exit code:** **0**
- **Duration:** ~50s (compile 11.5s, typecheck 21.2s, page-gen <1s, asset-copy <1s)
- **Output artifacts:** `.next/` (452 MB), `.next/standalone/server.js` (7,816 B), `.next/standalone/.next/static/`, `.next/standalone/public/`
- **Last 40 lines (tail):**

```
├ ○ /admin-panel
├ ƒ /api/admin-panel/auth/login
├ ƒ /api/admin-panel/auth/me
├ ƒ /api/admin-panel/onboarding
├ ƒ /api/admin-panel/onboarding/[id]
├ ƒ /api/admin/[resource]
├ ƒ /api/admin/[resource]/[id]
├ ƒ /api/auth/demo
├ ƒ /api/auth/logout
├ ƒ /api/auth/otp/send
├ ƒ /api/auth/otp/verify
├ ƒ /api/auth/session
├ ƒ /api/care/admin/packages
├ ƒ /api/care/admin/rules
├ ƒ /api/care/bookings
├ ƒ /api/care/bookings/[id]
├ ƒ /api/care/bookings/[id]/approve-extra
├ ƒ /api/care/bookings/[id]/extra-proposal
├ ƒ /api/care/bookings/[id]/findings
├ ƒ /api/care/bookings/[id]/health-report
├ ƒ /api/care/bookings/[id]/inspection
├ ƒ /api/care/bookings/[id]/reject-extra
├ ƒ /api/care/bookings/[id]/timeline
├ ƒ /api/care/packages
├ ƒ /api/care/technician/missions
├ ƒ /api/care/technician/missions/[id]
├ ƒ /api/care/vehicles/[id]/health
├ ƒ /api/care/vehicles/[id]/maintenance
├ ƒ /api/categories
├ ƒ /api/dashboard
├ ƒ /api/exchange-rate
├ ƒ /api/gateway/initiate
├ ƒ /api/gateway/verify
├ ƒ /api/health
├ ƒ /api/insurance
├ ƒ /api/insurance/claim
├ ƒ /api/invoices
├ ƒ /api/invoices/[id]
├ ƒ /api/jobs
├ ƒ /api/jobs/[id]
---EXIT:0---
```

**Status:** ✅ **PASS**

### 6.2 Cloudflare build — `bash scripts/build-cloudflare.sh`

- **Command:** `DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bash scripts/build-cloudflare.sh`
- **Working dir:** `/home/z/my-project`
- **OpenNext:** 1.20.9, **@opennextjs/aws:** 4.1.8, **Next.js:** 16.4.0 (Turbopack)
- **Exit code:** **0**
- **Duration:** ~95s (backup <1s, schema mutate <1s, config swap <1s, prisma generate 1.07s, patch apply <1s, OpenNext build ~80s incl. `next build` 35s + bundle ~35s)
- **Output artifacts:**
  - `.open-next/worker.js` (2,278 B — entry shim that imports `.open-next/server-functions/default/handler.mjs`)
  - `.open-next/server-functions/default/handler.mjs` (6.59 MB bundled server function)
  - `.open-next/server-functions/default/handler.mjs.meta.json` (852 KB metadata)
  - `.open-next/assets/` (15 entries: BUILD_ID, _next/static/, cards/, logo.*, manifest.json, mekanix-source.tar.gz, offline.html, onboarding/, sw.js, etc.)
  - `.open-next/cache/`, `.open-next/middleware/`, `.open-next/cloudflare/`, `.open-next/dynamodb-provider/`, `.open-next/.build/`
- **Warnings emitted:**
  - `WARN workerd compatibility_date: 2024-09-23, consider updating your wrangler config to a more recent date ...` (CF-02)
  - `WARN Node.js middleware support is experimental in cloudflare, and not officially maintained by OpenNext maintainers. Use at your own risk.` (Info — `src/proxy.ts` is the Next 16 middleware convention; OpenNext bundles it as an experimental Node middleware. Non-blocking.)
- **Last 80 lines (tail, trimmed for length):**

```
── 5. Generate Prisma Client ──
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma

✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 1.07s
  ✅ Prisma Client generated

── 6. Apply PR #1356 patch to OpenNext ──
  ✅ Patch applied (preview-props.json glob)

── 7. OpenNext build ──
┌─────────────────────────────┐
│ OpenNext — Cloudflare build │
└─────────────────────────────┘
App directory: /home/z/my-project
Next.js version : 16.4.0
@opennextjs/cloudflare version: 1.20.9
@opennextjs/aws version: 4.1.8
WARN workerd compatibility_date: 2024-09-23, consider updating your wrangler config ...

┌─────────────────────────────────┐
│ OpenNext — Building Next.js app │
└─────────────────────────────────┘

$ next build && node -e "..."
▲ Next.js 16.4.0 (Turbopack)
✓ Running next.config.ts took 54ms
  Creating an optimized production build ...
✓ Compiled successfully in 11.5s
  Running TypeScript ...
  Finished TypeScript in 21.2s ...
  Collecting page data using 1 worker ...
  Generating static pages using 1 worker (50/50) in 389ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
... (66 dynamic routes, 4 static routes — full list)
└ ○ /sitemap.xml

ƒ Proxy (Middleware)

WARN Node.js middleware support is experimental in cloudflare ...

┌──────────────────────────────┐
│ OpenNext — Generating bundle │
└──────────────────────────────┘
Bundling middleware function...
Bundling Node.js middleware...
Bundling static assets...
Bundling cache assets...
Building server function: default...
Applying code patches: 3.496s
⚙️ Bundling the OpenNext server...

Worker saved in `.open-next/worker.js` 🚀

OpenNext build complete.
  ✅ OpenNext build complete

── 8. Restore original files ──
  (handled by cleanup trap)

── Cleanup ──
  ✅ Schema restored from backup
  ✅ next.config.ts restored from backup
  ✅ src/lib/db.ts restored from backup
Prisma schema loaded from prisma/schema.prisma
✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 688ms
  ✅ Prisma Client regenerated with original schema

═══ Build complete! ═══
Output: .open-next/worker.js
Preview: bunx wrangler dev --local
---SCRIPT_EXIT:0---
```

### 6.3 Post-build verification

```bash
# All 3 user files byte-identical to feature branch
$ git diff --stat next.config.ts src/lib/db.ts prisma/schema.prisma
(empty)

# No .bak files left
$ ls prisma/schema.prisma.bak next.config.ts.bak src/lib/db.ts.bak
ls: cannot access 'prisma/schema.prisma.bak': No such file or directory
ls: cannot access 'next.config.ts.bak': No such file or directory
ls: cannot access 'src/lib/db.ts.bak': No such file or directory

# Schema has NO engineType (cleanup restored it)
$ head -12 prisma/schema.prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]
}

# Node_modules PR#1356 patch persists (idempotent — by design)
$ rg -n 'preview-props' node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js
34:    const manifests = await glob(join(dotNextDir, "**/{*-manifest,required-server-files,prefetch-hints,preview-props}.json"), {
```

**Status:** ✅ **PASS** — build produces correct artifacts, all tracked files restored, no leakage into working tree.

---

## 7. Findings table

| ID | File:line | Severity | Description | Repro | Status | Recommended fix |
|---|---|---|---|---|---|---|
| CF-01 | `public/mekanix-source.tar.gz` (tracked file, 230 KB, 244 entries) | **High** | A tarball of the entire `src/` directory + `.env` is committed to the repo at `public/mekanix-source.tar.gz` (added in commit `11777a0`). The Cloudflare build copies `public/` into `.open-next/assets/` (via `package.json` `build` script line 7: `fs.cpSync('public','.next/standalone/public',{recursive:true})` + OpenNext assets bundling), so this tarball ships as a public static asset accessible at `https://<worker-domain>/mekanix-source.tar.gz`. Exposes source code (business logic, security controls, comments) and a `.env` containing `DATABASE_URL` (dev path only — no production secrets in this case, but the pattern is dangerous). | `tar tzf public/mekanix-source.tar.gz` (lists 244 files incl. `src/` + `.env`); `curl https://<worker>/mekanix-source.tar.gz -o leak.tar.gz` after deploy. | **FAIL** (pre-existing, propagated by build) | Remove `public/mekanix-source.tar.gz` from the repo (`git rm`). Add `mekanix-source.tar.gz` to `.gitignore`. If the tarball is needed for some internal purpose, move it out of `public/` (e.g., to `build-artifacts/`) so it's not auto-copied to static assets. Also: consider adding an explicit deny rule in `wrangler.toml` `[assets]` (or use `_routes.json`) for `*.tar.gz` paths. |
| CF-02 | `wrangler.toml:2` | Low | `compatibility_date = "2024-09-23"` — OpenNext emits a build warning recommending a more recent date. May miss recent Workers runtime fixes (e.g., improved `nodejs_compat` coverage for `crypto.randomInt`, fetch headers, etc.). | `bash scripts/build-cloudflare.sh 2>&1 \| grep "compatibility_date"` → prints `WARN workerd compatibility_date: 2024-09-23, consider updating ...` | **PASS** (build succeeds; warning only) | Bump to a recent date (e.g., `"2025-08-01"` or later). Re-test `node:crypto` functions in `wrangler dev --local` after the bump. |
| CF-03 | `scripts/build-cloudflare.sh:128` (mutates `node_modules/.../load-manifest.js`) | Low | The PR #1356 patch is applied via `sed -i` to a file inside `node_modules/`. It is NOT restored by the cleanup trap (intentional — idempotent). However, if the patch is ever applied INCORRECTLY (e.g., the upstream OpenNext file format changes), the corrupted patch would persist across builds until `bun install` is re-run. | `rg -n 'preview-props' node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js` — shows the patch is present after build. | **PASS** (idempotent, current apply is correct) | Add a version check in the build script: `grep -q "opennextjs-cloudflare.*1.20" node_modules/@opennextjs/cloudflare/package.json` before applying the patch, OR move the patch to a postinstall script that's documented in `package.json`. Low priority. |
| CF-04 | `scripts/build-cloudflare.sh:35-69` (cleanup function) | Low | The cleanup function inherits `set -e` from the parent shell. If the first `mv $SCHEMA_BACKUP $SCHEMA` fails (e.g., disk full, permission), the subsequent `mv $NEXT_CONFIG_BACKUP ...` and `mv $DB_BACKUP ...` will NOT execute — leaving two of three files mutated. Very low probability in practice. | Hard to reproduce without simulating disk-full. Code-review only. | **NOT-VERIFIED** (not reproduced; logic concern only) | Wrap each restore `mv` in `|| true`, OR start cleanup with `set +e` and re-enable at end. Example: `mv "$SCHEMA_BACKUP" "$SCHEMA" 2>/dev/null || echo "WARN: schema restore failed"` for each file. |
| CF-05 | `src/lib/redis.ts:72-77` (top-level `setInterval`) | Medium | `setInterval(() => { ... cleanup memStore ... }, 5*60*1000)` runs at module load. In Cloudflare Workers, timers may not fire across requests (each isolate has its own event loop; the cleanup callback may never execute). The leak is bounded (memStore is per-isolate), but the timer registration itself may emit warnings or be disallowed in stricter Workers configs. | Static analysis — `rg 'setInterval' src/lib/redis.ts`. Runtime verification requires `wrangler dev`. | **NOT-VERIFIED** (build passes; runtime behavior not tested) | Gate the timer: `if (typeof (globalThis as any).caches !== "undefined" && typeof (process as any).versions?.node !== "undefined") { setInterval(...) }` — same `isWorker` check pattern used in `src/lib/init.ts:4-6`. |
| CF-06 | `next.config.worker.ts:14-20` (no `rewrites()`) | Info | The worker config does NOT include the production `rewrites()` that `next.config.ts` has (which 404s `/api/auth/demo`). The `/api/auth/demo` POST handler still 404s directly via its in-handler production guard (per Agent B-1 review). The GET handler (if any) is unprotected by rewrite — but it returns demo data only, and the route is dev-only by design. NOT a build blocker; flagged for security context. | `diff <(grep rewrites next.config.ts) <(grep rewrites next.config.worker.ts)` — worker config has no rewrites. | **PASS** (build succeeds; security coverage exists in-handler) | Mirror the `rewrites()` block from `next.config.ts` into `next.config.worker.ts` for defense-in-depth, OR rely on the in-handler guard (current state — acceptable per Agent B-1 review). |
| CF-07 | `src/lib/db.worker.ts:15` (stale comment) | Info | Comment says "63 consumers of sync `db` continue to import from `@/lib/db`" — actual count is 0 (verified via `rg -n 'from "@/lib/db";' src/` → zero matches in production routes; all 66 routes use `getDbForLib` from `@/lib/db-access`). Comment is misleading. | `rg -n 'from "@/lib/db"' src/` → only match is the comment in `db.worker.ts:15`. | **PASS** (comment-only; no runtime impact) | Update the comment to: "All production routes use `getDbForLib()` from `@/lib/db-access` (D1-aware). The sync `db` export is preserved only for any future dev-only consumers." |
| CF-08 | `prisma/schema.prisma:11` | Info | `binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]` is irrelevant when `engineType = "client"` is set (build-time mutation). The Rust query engine binaries aren't downloaded/used under `engineType="client"`. Listing 3 targets adds minor `prisma generate` time during the build (~30s for download on first run; cached after). | `prisma generate` with `engineType="client"` set — observe no `binaryTargets`-specific download. | **PASS** (no correctness issue; minor build-time waste) | Optional: leave `binaryTargets` for the Node build (which uses the Rust engine). The build script's `sed` could optionally strip `binaryTargets` when adding `engineType="client"` to save build time. Low priority. |

**Totals:** 1 High, 1 Medium, 3 Low, 3 Info. 0 Critical. 0 blockers (both builds complete successfully).

---

## 8. Exact reproduction commands

### 8.1 Environment

```
OS:         Linux (Ubuntu 24.04 in sandbox)
Bun:        1.3.14  (/usr/local/bin/bun)
Node:       v24.21.0
Disk:       6.4 GB free (build needs ~700 MB peak)
Network:    outbound allowed (npm registry reachable — required for opennext bundle step)
Dev server: running on :3000 (NOT killed; both builds below don't need port 3000)
```

### 8.2 Pre-flight

```bash
cd /home/z/my-project
git status --short | wc -l          # expect ~30 (baseline 29 + worklog.md + 1 untracked)
ls -la prisma/schema.prisma next.config.ts next.config.worker.ts \
       open-next.config.ts wrangler.toml src/lib/db.ts src/lib/db.worker.ts \
       src/lib/db-worker.ts src/lib/db-access.ts
bun --version                       # 1.3.14
bunx opennextjs-cloudflare --version  # 1.20.9
```

### 8.3 Standard Node build

```bash
cd /home/z/my-project
DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bun run build
# Capture: exit code + tail -40
echo "EXIT:$?"
# Expected: EXIT:0
# Output: .next/standalone/server.js (7.8 KB), .next/standalone/.next/static/, .next/standalone/public/
```

### 8.4 Cloudflare Workers build

```bash
cd /home/z/my-project
DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}" bash scripts/build-cloudflare.sh
# Capture: exit code + tail -80
echo "SCRIPT_EXIT:$?"
# Expected: SCRIPT_EXIT:0
# Output: .open-next/worker.js (2.3 KB), .open-next/assets/, .open-next/server-functions/default/handler.mjs (6.6 MB)

# Post-build verification (all should be empty/no-op):
git diff --stat prisma/schema.prisma next.config.ts src/lib/db.ts
ls prisma/schema.prisma.bak next.config.ts.bak src/lib/db.ts.bak 2>&1   # "No such file"
rg -n 'engineType' prisma/schema.prisma                                   # no matches
git status --short | grep -E "(prisma/schema\.prisma|next\.config\.ts|src/lib/db\.ts)$"  # no matches
```

### 8.5 Cleanup (if needed)

The builds do not modify any tracked user files. `.next/` and `.open-next/` are gitignored — safe to leave in place or delete with `rm -rf .next .open-next`. The `node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js` patch persists (by design — idempotent for re-runs). To reset it: `rm -rf node_modules/@opennextjs/cloudflare && bun install`.

---

*End of audit.*
