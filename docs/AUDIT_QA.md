# AUDIT — Quality Gate (Task E-6)

**Agent:** QA / Test Engineer (Agent 6)
**Task ID:** E-6
**Date:** 2026-10-23
**Working tree:** `feature/cloudflare-d1-validation @ 1cf59e7` (identical to working tree @ HEAD `23b71d2`); 29 modified tracked files = recovered UI assets (untouched per coordinator constraint).
**Mode:** READ-ONLY on source EXCEPT one new file `tests/unit/qa-repro.test.ts`. No push / deploy / remote-migration. Dev server on :3000 left running. Did NOT re-run `bun run build` or `bash scripts/build-cloudflare.sh` (B-2 already executed both, exit 0; cited in §2).

---

## 1. Executive Summary

The mekanix-app quality gate **PASSES** on every command that could be executed in this 4 GB sandbox, with **one environmental BLOCKER** that is not a code regression:

- ✅ **`bunx tsc --noEmit`**: exit 0 — zero TypeScript errors across the entire repo (src/, tests/, scripts/).
- ✅ **`bash scripts/check-hygiene.sh`**: exit 0 — no tracked DB files, no tracked `.env`, no large binaries, no forbidden directories.
- ✅ **`bun run test`**: exit 0 — **421 tests** (418 passed + 3 expected-fail via `it.fails()`), 23 test files, 13.4 s. Zero unexpected failures.
- ⚠️ **`bun run lint` (the canonical `eslint .` script)**: BLOCKED in this 4 GB sandbox — Node V8 heap exhausted at ~2 GB heap usage (regardless of `--max-old-space-size=2048 / 2560 / 3072 / 4096`), and the OS OOM-killer SIGKILLs the process at higher limits. The dev server on :3000 (~290 MB RSS) plus Caddy + 3 bun hot-reload processes leave only ~3.2 GB available. **The scoped equivalent `bunx eslint src tests scripts` PASSES (exit 0, 2 warnings)** — see §2.1 + §7.
- ✅ **`bun run build`** (standard): exit 0 — cited from B-2's `docs/AUDIT_CLOUDFLARE_BUILD.md` §1.
- ✅ **`bash scripts/build-cloudflare.sh`**: exit 0 — cited from B-2's `docs/AUDIT_CLOUDFLARE_BUILD.md` §1.

Two concrete bugs surfaced by the parallel audit agents had **no automated test coverage**; both now have repro tests in `tests/unit/qa-repro.test.ts` (5 tests, 3 pass + 2 expected-fail):

| Repro ID | Bug Source | Severity | Bug | Status |
| --- | --- | --- | --- | --- |
| **QA-01** | B-3 → AUDIT_D1_PRISMA.md §7.4 (D1-01) | **CRITICAL** | `RateLimit` + `IdempotencyKey` declared in `prisma/schema.prisma` (lines 1335, 1346) but **missing CREATE TABLE** in `prisma/migrations/20260925000000_init/migration.sql`. Production rate limiting + idempotency silently degrade to per-isolate in-memory. | **UNFIXED** (documented via `it.fails()`) |
| **QA-02** | B-3 → AUDIT_D1_PRISMA.md §8 (D1-02) | **HIGH (perf)** | `src/app/api/auth/otp/verify/route.ts:91-93` performs unbounded `db.user.findMany({ select: { id: true, phone: true } })` (no `where`, no `take`) on every OTP verify whose normalized phone does not match the stored value — full-table scan per login. | **UNFIXED** (documented via `it.fails()`) |

The D1 test coverage gap is real and unchanged from B-3's finding: **zero tests** reference `PrismaD1`, `@prisma/adapter-d1`, `getCloudflareContext`, `env.DB`, or `cloudflare-workers`. Every test mocks `getDbForLib` to return a plain JS object — no test verifies PrismaD1 adapter wiring, migration correctness, or D1-table existence. The new `qa-repro.test.ts` mitigates one slice of this gap (schema-vs-migration drift) by operating on the filesystem directly.

---

## 2. Quality Gate Table

| Check | Command | Exit Code | Result | Evidence |
| --- | --- | --- | --- | --- |
| Lint (canonical) | `bun run lint` (= `eslint .`) | 134 / SIGABRT | **BLOCKED** (env) | V8 OOM at ~2 GB heap (`Ineffective mark-compacts near heap limit`); reproducible with `NODE_OPTIONS=--max-old-space-size=2048/2560/3072/4096` (4096 → SIGKILL 137 from OS OOM-killer). Sandbox = 4 GB total / 3.2 GB available (dev server :3000 + Caddy + 3 bun --hot procs already running). See §7. |
| Lint (scoped, alternate) | `NODE_OPTIONS=--max-old-space-size=2048 bunx eslint src tests scripts` | 0 | **PASS** (alt) | 2 warnings only: (1) unused `eslint-disable` directive in `src/components/mek/app-shell.tsx:66`; (2) `window.location.href` navigation in `src/lib/admin-api-client.ts:33`. Zero errors. |
| TypeScript | `bunx tsc --noEmit` | 0 | **PASS** | Zero errors. (No output → no diagnostics.) |
| Hygiene | `bash scripts/check-hygiene.sh` | 0 | **PASS** | `✅ Repository hygiene is clean.` (no tracked DB files, no tracked `.env`, no large binaries, no forbidden directories). |
| Unit / integration / e2e tests | `bun run test` (= `vitest run`) | 0 | **PASS** | 23 test files, **421 tests** (418 passed + 3 expected-fail), 13.4 s duration. 0 unexpected failures. The 3 expected-fails are documented `it.fails()` tests (PAY-05 from B-5, QA-01 + QA-02 from this agent). |
| Standard build | `bun run build` | 0 | **PASS** (cited) | Not re-run; cited from B-2 `docs/AUDIT_CLOUDFLARE_BUILD.md` §1: "exit 0, ~50 s, .next/standalone/server.js produced". |
| Cloudflare build | `bash scripts/build-cloudflare.sh` | 0 | **PASS** (cited) | Not re-run; cited from B-2 `docs/AUDIT_CLOUDFLARE_BUILD.md` §1: "exit 0, ~95 s, .open-next/worker.js (2.3 KB entry shim) + .open-next/server-functions/default/handler.mjs (6.6 MB)". |

**Bottom-line gate status: PASS** (lint is environmentally blocked but its scoped equivalent passes; all other checks PASS on real execution).

---

## 3. Test Inventory

### 3.1 Aggregate counts (final, after E-6 additions)

| Metric | Value |
| --- | --- |
| Test files executed | 23 |
| Total tests | **421** |
| Passed | **418** |
| Failed (unexpected) | **0** |
| Expected fail (`it.fails()` documenting unfixed bugs) | **3** |
| Skipped | 0 |
| Duration | 13.40 s |
| Exit code | 0 |

### 3.2 The two new test files added by parallel agents (B-4, B-5)

| File | Tests | Pass | Expected-fail | Fail (unexpected) | Owning agent | Audit report |
| --- | --- | --- | --- | --- | --- | --- |
| `tests/unit/security-audit-negative.test.ts` | 13 | 13 | 0 | 0 | B-4 (Backend Security) | `docs/AUDIT_SECURITY.md` |
| `tests/unit/payment-wallet-audit.test.ts` | 14 | 13 | 1 | 0 | B-5 (Payment/Wallet) | `docs/AUDIT_PAYMENT_WALLET.md` |

Both files ran green in the suite on first execution by this agent — no regressions, no skipped tests, no environment-specific skip. Each confirms via real `vi.mock` of `@/lib/db-access` (returning a plain JS PrismaClient stub) + real `requireAuth` / `requireJobParticipant` / `requireVehicleOwner` helpers run unmocked.

### 3.3 The one new test file added by this agent (E-6)

| File | Tests | Pass | Expected-fail | Fail (unexpected) | Documents |
| --- | --- | --- | --- | --- | --- |
| `tests/unit/qa-repro.test.ts` | 5 | 3 | 2 | 0 | QA-01 (D1-01 schema-migration drift, CRITICAL) + QA-02 (D1-02 unbounded findMany in OTP verify, HIGH/perf) |

Suite totals evolved as:
- B-5 baseline: 21 files / 403 tests (402 pass + 1 expected-fail)
- After B-4 added `security-audit-negative.test.ts`: 22 files / 416 tests (415 pass + 1 expected-fail) ← matches B-4's reported number
- After E-6 added `qa-repro.test.ts`: 23 files / 421 tests (418 pass + 3 expected-fail)

---

## 4. Failing Tests Detail

There are **3 `it.fails()` tests in the suite. All three are intentional** (each documents an unfixed bug surfaced by a parallel audit agent). **Zero unexpected failures.**

### 4.1 `it.fails()` #1 — PAY-05 VIP-01 race (from B-5)

| Field | Value |
| --- | --- |
| File | `tests/unit/payment-wallet-audit.test.ts` |
| Test name | (inside `describe("/api/vip/subscribe — VIP-01 non-atomic payment-reuse race")`) |
| Expected | Two concurrent `POST /api/vip/subscribe` with the same `paymentId` should NOT both create an `ACTIVE` `UserVipSubscription` (P2002 unique-violation, or 409 response). |
| Actual | Both requests pass the `findFirst({ where: { paymentId, status: { in: [...] } } })` check and both call `userVipSubscription.create({ data: { paymentId } })` — the second succeeds because `paymentId` is NOT `@@unique` on `UserVipSubscription` (`schema.prisma:789-803`). Two ACTIVE subscriptions exist for the same paymentId. |
| Root cause | `src/app/api/vip/subscribe/route.ts:63-68` does a non-atomic read-then-write: `findFirst` (check) → `create` (write). No `@@unique([paymentId])` constraint in the schema to backstop the race. |
| Owning agent | B-5 (Payment & Wallet Auditor) |
| Severity | HIGH |
| Audit ref | `docs/AUDIT_PAYMENT_WALLET.md` PAY-05 |

### 4.2 `it.fails()` #2 — QA-01 D1-01 schema/migration drift (new, from E-6)

| Field | Value |
| --- | --- |
| File | `tests/unit/qa-repro.test.ts` |
| Test name | `QA-01 — D1-01 schema/migration drift (CRITICAL) > every model in schema.prisma has a matching CREATE TABLE in the D1 migration` |
| Expected | Every `model Foo { … }` in `prisma/schema.prisma` has a corresponding `CREATE TABLE "Foo"` in `prisma/migrations/20260925000000_init/migration.sql`. |
| Actual | 61 models in schema; only 59 `CREATE TABLE` statements in migration. **Missing:** `RateLimit` (`schema.prisma:1335-1343`), `IdempotencyKey` (`schema.prisma:1346-1354`). |
| Root cause | The initial migration `20260925000000_init` was generated before the `RateLimit` + `IdempotencyKey` models were added to `schema.prisma`; no follow-up migration was ever created. The Prisma Client generated against the schema emits `db.rateLimit.updateMany(...)` / `db.idempotencyKey.findUnique(...)` etc.; on a real D1 these throw "no such table: RateLimit"; the `try/catch` in `src/lib/rate-limit.ts:106-109` + `src/lib/auth.ts:485-494` swallows the error and silently falls back to per-isolate in-memory state. |
| Owning agent | E-6 (this agent) — original finding by B-3 |
| Severity | CRITICAL |
| Audit ref | `docs/AUDIT_D1_PRISMA.md` §7.4 (D1-01) |

### 4.3 `it.fails()` #3 — QA-02 D1-02 unbounded `User.findMany` in OTP verify (new, from E-6)

| Field | Value |
| --- | --- |
| File | `tests/unit/qa-repro.test.ts` |
| Test name | `QA-02 — D1-02 unbounded User.findMany in OTP verify (HIGH/perf) > OTP verify route does NOT perform an unbounded User.findMany (select-only, no where/take)` |
| Expected | The OTP verify route does NOT contain an unbounded `db.user.findMany({ select: { id: true, phone: true } })` call (no `where:`, no `take:`). |
| Actual | The route DOES contain exactly that call at `src/app/api/auth/otp/verify/route.ts:91-93`, as a fallback for legacy users whose stored phone does not match the input normalized phone. On D1 this loads every `User` row into the Worker isolate per OTP verify (with >1000 users → dominates Worker CPU time and risks 50 ms+ p99 latency on every login). |
| Root cause | Original design used digits-only matching to handle legacy phone storage (e.g. "+1-415-224-1180" vs "+14152241180"); the fallback was never replaced with a `findUnique({ where: { phone } })` against a normalized `phone` field. |
| Owning agent | E-6 (this agent) — original finding by B-3 |
| Severity | HIGH (performance) |
| Audit ref | `docs/AUDIT_D1_PRISMA.md` §8 (D1-02) |

---

## 5. D1 Test Coverage Gap Analysis

### 5.1 What was checked

Searched `tests/` recursively (ripgrep, case-insensitive) for every D1-relevant symbol:

- `PrismaD1` — 0 matches
- `@prisma/adapter-d1` — 0 matches
- `getCloudflareContext` — 0 matches
- `env.DB` — 0 matches
- `cloudflare-workers` — 0 matches
- `getDbForLib` — 10 matches, but ALL 10 are `vi.fn(async () => ({ … }))` mocks (in `admin-audit`, `admin-login`, `admin-status-validation`, `offline-queue`, `payment-wallet-audit`, `security-audit-negative`, `timeline-bola`, `vip-subscribe`, `wallets-auto-release`, `wallets-withdraw`). None verifies the real `db-worker.ts` PrismaD1 wiring.

### 5.2 What this means

Every existing test mocks the entire DB access layer (`getDbForLib` → plain JS object) at the boundary. This is the right unit-test pattern (route handlers are tested in isolation), but it leaves the following categories with **zero coverage** (matches B-3 §9.1-9.7 almost item-for-item):

| Gap category | Concrete examples | Would catch |
| --- | --- | --- |
| D1 adapter integration | `getDbForLib()` returns PrismaClient wired with `PrismaD1` when `navigator.userAgent === "Cloudflare-Workers"`; per-request cache via `Symbol.for("mekanix.prismaClient")`; `db.worker.ts:30-39` throwing Proxy in Workers runtime | Misconfigured adapter wiring |
| Migration correctness | schema-vs-migration drift; migration idempotency; `wrangler d1 migrations list --local` shows zero pending | **D1-01** (now mitigated by `qa-repro.test.ts` QA-01) |
| Rate-limit / IdempotencyKey persistence | `rateLimitAsync` writes to D1 (not just in-memory); `withIdempotency` round-trips through D1 | **D1-01** silent fallback |
| Race / atomicity (partial) | Mid-flow failure between `walletTransaction.updateMany` (count=1) and `wallet.update` (D1-04 lost funds); duplicate-payment path on `vip/subscribe` (D1-03); `payments/route.ts:128,174` warranty `.catch(() => {})`; `reviews/route.ts` P2002 → 500 (D1-09); `approve-extra` state inconsistency (D1-11) | D1-03 / D1-04 / D1-05 / D1-09 / D1-11 |
| Performance / pagination | `auth/otp/verify/route.ts:91` unbounded findMany (D1-02); ~25 other `findMany` calls without `take:` (D1-07) | **D1-02** (now mitigated by `qa-repro.test.ts` QA-02); D1-07 |
| Workers-runtime smoke | End-to-end Miniflare boot: `GET /api/health` (verifies `PrismaD1` + `$queryRaw\`SELECT 1\``), `POST /api/auth/otp/send` (verifies RateLimit table hit), `wrangler.toml` DB binding | D1-01 at integration level; binding misconfig |
| Schema/migration drift (CI gate) | `bunx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-migrations prisma/migrations --script` is non-empty → fail CI | **D1-01** at PR time |

### 5.3 Status

- B-3 listed 9 categories of missing tests; E-6 has added 2 (the schema-migration drift slice + the OTP verify unbounded-findMany slice, both via static filesystem checks in `qa-repro.test.ts`). **7 categories remain uncovered.**
- The two mitigated slices use static / filesystem checks (no D1 binding required) — they catch the same bug at PR time that a runtime integration test would catch at deploy time. A future iteration should add Miniflare-based smoke tests (§5.2 row "Workers-runtime smoke") for true end-to-end coverage.

---

## 6. Repro Tests Added

### 6.1 File created

**Path:** `/home/z/my-project/tests/unit/qa-repro.test.ts` (the one new source file E-6 is permitted to create).

**Tests added:** 5 (3 PASS, 2 EXPECTED-FAIL via `it.fails()`).

**Pattern:** filesystem-only — no DB, no Worker, no Redis, no mocks of `getDbForLib`. Reads `prisma/schema.prisma` + `prisma/migrations/20260925000000_init/migration.sql` + `src/app/api/auth/otp/verify/route.ts` directly. Each bug is documented via `it.fails()` so the suite stays green; when the fix lands, flip the wrapper to `it()` to start enforcing.

### 6.2 Test breakdown

| # | Test name | Result | Documents |
| --- | --- | --- | --- |
| 1 | `QA-01 … control — schema.prisma declares a non-empty set of models` | PASS (61 models > 50 threshold) | sanity check |
| 2 | `QA-01 … control — migration.sql declares a non-empty set of CREATE TABLEs` | PASS (59 tables > 50 threshold) | sanity check |
| 3 | `QA-01 … every model in schema.prisma has a matching CREATE TABLE in the D1 migration` | **EXPECTED-FAIL** | D1-01 (CRITICAL) |
| 4 | `QA-01 … documents the exact drift — only RateLimit + IdempotencyKey are missing` | PASS (`["IdempotencyKey", "RateLimit"]`) | pins current drift so a partial fix doesn't silently regress |
| 5 | `QA-02 … OTP verify route does NOT perform an unbounded User.findMany (select-only, no where/take)` | **EXPECTED-FAIL** | D1-02 (HIGH/perf) |

### 6.3 Suite results after adding `qa-repro.test.ts`

```
 ✓ tests/unit/qa-repro.test.ts (5 tests) 12ms
 Test Files  23 passed (23)
      Tests  418 passed | 3 expected fail (421)
   Duration  13.40s
===EXITCODE===: 0
```

### 6.4 Verification

- The 2 `it.fails()` tests were verified to actually exercise the bug: when the wrapper is flipped to plain `it()`, both tests fail with concrete assertion errors (e.g. for QA-01: `expected [ 'IdempotencyKey', 'RateLimit' ] to equal []`).
- The 3 PASS tests were verified to fail if the underlying assumption breaks (e.g. test #4 would fail if a partial fix added only one of the two missing tables).

---

## 7. Environment Limitations

### 7.1 `bun run lint` (canonical `eslint .`)

- **Limitation:** V8 heap OOM at ~2 GB usage; SIGABRT (134) on first run, then SIGKILL (137) from OS OOM-killer when `--max-old-space-size` raised to 3 GB+. Sandbox = 4 GB total RAM, dev server on :3000 + Caddy + 3 bun --hot reload procs already running (combined ~700 MB RSS), leaving only ~3.2 GB free for ESLint.
- **Root cause:** `eslint .` traverses the entire repo (incl. `public/mekanix-source.tar.gz`, onboarding images, `mini-services/`, etc.). The `.eslintignore` file is unsupported in modern ESLint (warning emitted: "Switch to using the `ignores` property in `eslint.config.js`") — so its single entry `.open-next/` is the only ignore applied. The eslint.config.mjs `ignores` block already excludes `node_modules`, `.next`, `out`, `build`, `examples`, `skills`, `mini-services`, `experiments`, `admin-panel` — but these are NOT applied when `.eslintignore` is in use (legacy fallback).
- **Alternative executed:** `NODE_OPTIONS=--max-old-space-size=2048 bunx eslint src tests scripts` — exit 0, 2 warnings only.
- **Why this is not a code regression:** The Next.js ESLint config passes cleanly when scoped to the actual source code. The OOM is purely an environmental artifact of (a) the 4 GB sandbox + concurrent dev server, and (b) the legacy `.eslintignore` file shadowing the modern `ignores` array in `eslint.config.mjs`.
- **Recommended fix (NOT applied — out of E-6 scope):** Delete `.eslintignore` and migrate its entries into `eslint.config.mjs` `ignores`. This is also recommended by ESLint's own deprecation warning. A separate LOW-severity finding (QA-04 below) is logged for this.

### 7.2 `bun run test:coverage`

- **Limitation:** Fails with `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'` (exit 1). The package is not in `package.json` dependencies.
- **Alternative executed:** None (coverage is optional per task description).
- **Recommended fix (NOT applied — out of E-6 scope):** Add `@vitest/coverage-v8` as a devDependency, then re-run.

### 7.3 Not executed (per task constraints)

- `bun run build` — already executed by B-2 (exit 0); cited, not re-run.
- `bash scripts/build-cloudflare.sh` — already executed by B-2 (exit 0); cited, not re-run.
- `bunx wrangler d1 migrations apply --local` — would have required running `bunx prisma generate` first, which the coordinator baseline forbade (disrupts dev server on :3000). The schema-vs-migration drift was instead verified by `qa-repro.test.ts` QA-01 (static filesystem check).

---

## 8. Findings Table

| ID | Severity | Description | Status | Fix |
| --- | --- | --- | --- | --- |
| **QA-01** | CRITICAL | D1-01 (B-3): `RateLimit` + `IdempotencyKey` declared in `prisma/schema.prisma` (lines 1335, 1346) but missing `CREATE TABLE` in `prisma/migrations/20260925000000_init/migration.sql`. Production rate limiting + idempotency silently degrade to per-isolate in-memory. | UNFIXED — documented via `it.fails()` in `qa-repro.test.ts` | Add new migration `<timestamp>_add_d1_rate_limit_idempotency/migration.sql` with the two CREATE TABLE statements (see AUDIT_D1_PRISMA.md §7.4 for exact SQL). Apply via `wrangler d1 migrations apply` (NOT in this audit — deploy step). |
| **QA-02** | HIGH (perf) | D1-02 (B-3): `src/app/api/auth/otp/verify/route.ts:91-93` performs unbounded `db.user.findMany({ select: { id: true, phone: true } })` (no `where`, no `take`) on every OTP verify whose normalized phone does not match the stored value. | UNFIXED — documented via `it.fails()` in `qa-repro.test.ts` | Replace with `db.user.findUnique({ where: { phone } })` against normalized phone (already `@unique`). Run a one-time backfill migration that normalizes `User.phone` (strip non-digits). If legacy lookup is still needed, add a `phoneDigits` column + index. |
| **QA-03** | BLOCKED (env) | `bun run lint` (canonical `eslint .`) OOMs in this 4 GB sandbox. Not a code regression — `bunx eslint src tests scripts` passes (exit 0, 2 warnings). | OPEN | Delete legacy `.eslintignore` (its contents are shadowed by `eslint.config.mjs` `ignores` anyway). Migrate any missing entries into `eslint.config.mjs` `ignores`. CI should run on a host with ≥ 8 GB RAM. (Out of E-6 scope.) |
| **QA-04** | LOW (dev-dep) | `bun run test:coverage` fails: `@vitest/coverage-v8` is referenced in `vitest.config.ts` but missing from `package.json` devDependencies. | OPEN | `bun add -d @vitest/coverage-v8` then `bun run test:coverage`. (Out of E-6 scope.) |
| **QA-05** | INFO (lint warning) | `src/components/mek/app-shell.tsx:66` has an unused `eslint-disable` directive for `react-hooks/set-state-in-effect` (the rule is already disabled in `eslint.config.mjs:24`). | OPEN | Remove the `// eslint-disable-next-line react-hooks/set-state-in-effect` comment at line 66. (Out of E-6 scope.) |
| **QA-06** | INFO (lint warning) | `src/lib/admin-api-client.ts:33` uses `window.location.href` for internal navigation; ESLint flags `@next/next/no-location-assign-relative-destination`. | OPEN | Replace with `useRouter().push()` from `next/navigation` (the file is already client-side — uses `window`). (Out of E-6 scope.) |

---

## 9. Methodology + Constraints Honored

- All findings verified by direct execution of the listed commands in this sandbox; exit codes captured via `${PIPESTATUS[0]}` / `$?`.
- READ-ONLY on all source EXCEPT one new file: `tests/unit/qa-repro.test.ts` (the file E-6 was permitted to create). Verified by `git status` after writing:
  - 1 new file: `tests/unit/qa-repro.test.ts`
  - 1 new file: `docs/AUDIT_QA.md` (this report)
  - 1 modified file: `worklog.md` (E-6 entry appended at end)
  - The 29 modified tracked files (recovered UI assets) were NOT touched.
- Did NOT re-run `bun run build` or `bash scripts/build-cloudflare.sh` (B-2 already executed both; cited from `docs/AUDIT_CLOUDFLARE_BUILD.md`).
- Did NOT run `bunx wrangler d1 execute` or `bunx prisma generate` or any remote migration.
- Did NOT kill the dev server on :3000 (verified running: `next-server (v16.4.0)` PID 4740).
- Did NOT push / deploy / remote-migrate.

---

## 10. Appendix — raw command outputs

### 10.1 `bunx tsc --noEmit`
```
$ bunx tsc --noEmit
(produces no output on success)
===EXITCODE===: 0
```

### 10.2 `bash scripts/check-hygiene.sh`
```
🔍 Checking repository hygiene...
✅ Repository hygiene is clean.
===EXITCODE===: 0
```

### 10.3 `bun run test` (final tail)
```
 ✓ tests/unit/qa-repro.test.ts (5 tests) 12ms
 ✓ tests/unit/timeline-bola.test.ts (5 tests) 13ms
 ✓ tests/unit/permissions.test.ts (20 tests) 15ms
 ✓ tests/unit/dispatch.test.ts (17 tests) 12ms
 ✓ tests/unit/lite-response.test.ts (17 tests) 11ms
 ✓ tests/unit/pricing.test.ts (20 tests) 11ms
 ✓ tests/unit/service-unified.test.ts (28 tests) 9ms

 Test Files  23 passed (23)
      Tests  418 passed | 3 expected fail (421)
   Start at  09:26:12
   Duration  13.40s (environment 53%, setup 21%, import 11%, transform 7%, tests 6%, worker 1%)

===EXITCODE===: 0
```

### 10.4 `bun run lint` (failure tail)
```
$ eslint .
(node:6119) ESLintIgnoreWarning: The ".eslintignore" file is no longer supported. Switch to using the "ignores" property in "eslint.config.js": https://eslint.org/docs/latest/use/configure/migration-guide#ignoring-files

<--- Last few GCs --->

[6119:0x74a1000]    90214 ms: Mark-Compact 2014.8 (2023.9) -> 1974.0 (1985.4) MB, pooled: 0 MB, 3470.97 / 0.00 ms  (average mu = 0.143, current mu = 0.105) allocation failure; scavenge might not succeed

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
error: script "lint" was terminated by signal SIGABRT (Abort)
===EXITCODE===: 134
```

### 10.5 `bunx eslint src tests scripts` (scoped alternative — PASS)
```
$ NODE_OPTIONS=--max-old-space-size=2048 bunx eslint src tests scripts --no-error-on-unmatched-pattern

/home/z/my-project/src/components/mek/app-shell.tsx
  66:3  warning  Unused eslint-disable directive (no problems were reported from 'react-hooks/set-state-in-effect')

/home/z/my-project/src/lib/admin-api-client.ts
  33:40  warning  Do not use `window.location.href` to navigate to internal Next.js pages. Use `redirect()` in the render phase, or `useRouter().push()` in Client Components' event handlers instead. See: https://nextjs.org/docs/messages/no-location-assign-relative-destination  @next/next/no-location-assign-relative-destination

✖ 2 problems (0 errors, 2 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.

===EXITCODE===: 0
```
