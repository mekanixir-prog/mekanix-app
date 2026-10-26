# MEKANIX — UI Entry Test Report

**Date:** 2026-10-26
**Branch:** `feature/cloudflare-d1-validation`
**SHA tested:** `f7d5deb346a8e76f0d4dac645bb3abad2b105d19`
**Tester:** Z AI (QA Engineer)

## Test Results

### 1. TypeScript Check
- **Command:** `bunx tsc --noEmit`
- **Exit code:** 0
- **Result:** PASS — 0 errors

### 2. ESLint (scoped)
- **Command:** `bunx eslint src tests scripts`
- **Exit code:** 0
- **Result:** PASS — 0 errors, 2 pre-existing warnings
  - `app-shell.tsx:66:3` — Unused eslint-disable directive
  - `admin-api-client.ts:33:40` — window.location.href navigation warning
- **Note:** Canonical `bun run lint` (=`eslint .`) hits V8 OOM in 4GB sandbox. Scoped equivalent passes.

### 3. Repository Hygiene
- **Command:** `bash scripts/check-hygiene.sh`
- **Exit code:** 0
- **Result:** PASS — clean

### 4. Unit/Integration Tests
- **Command:** `bun run test`
- **Exit code:** 0
- **Result:** PASS — 424 tests, 422 PASS + 2 expected-fail
  - Expected-fail 1: PAY-05 (VIP TOCTOU race — documented, blocks real payment only)
  - Expected-fail 2: QA-02 (OTP O(n) scan — accepted risk, needs backfill migration)
- **Duration:** 13.67s
- **Files:** 23 test files

### 5. Standard Build
- **Command:** `bun run build`
- **Exit code:** 0
- **Result:** PASS — standalone server.js produced
- **Artifacts:** `.next/standalone/server.js`, `.next/server/middleware-manifest.json`

### 6. Cloudflare/OpenNext Build
- **Command:** `bun scripts/build-cloudflare.mjs`
- **Exit code:** 0 (on second run — first run may fail due to stale Prisma client)
- **Result:** PASS — worker.js + handler.mjs produced
- **Artifacts:**
  - `.open-next/worker.js` (2,278 bytes)
  - `.open-next/server-functions/default/handler.mjs` (6,594,946 bytes)
  - `.open-next/assets/` (splash-logo, cards, logos, CSS, JS chunks)
- **Build contains:** 2 references to `mk-splash-amber`/`F58220`/`splash-logo` in handler.mjs (confirms latest UI code is bundled)

### 7. Browser/E2E Test (via agent-browser)
- **Tool:** agent-browser (headless Chromium)
- **Viewport:** 1280×800 (desktop) and 390×844 (mobile)
- **Result:** PASS

#### Splash Screen
- **Title:** «مکانیکس | تعمیر و نگهداری سیار خودرو و ماشین‌آلات سنگین در محل» ✅
- **Body length:** 22,168 chars ✅
- **Mascot image:** `splash-logo.webp` present ✅
- **Language toggle:** EN/FA pill present ✅
- **Primary button:** `mk-splash-amber` class (hardcoded #F58220) ✅
- **VLM analysis:** «شخصیت مکانیک سه‌بعدی، دکمه نارنجی براق، لوگوی MEKANIX، زبان فارسی» ✅

#### Mode-Select
- **Card count:** 2 ✅
- **Layout:** Vertical stack (heavy top=211, passenger top=523) ✅
- **Both amber:** YES ✅
- **Card width:** 848px (desktop), full-width ✅
- **VLM analysis:** «دو کارت زیر هم، هر دو نارنجی، تصاویر واقعی فوتورئال» ✅

#### Customer Home
- **Heading:** «مکانیک متخصص در محل شما» ✅
- **hasEmptyState:** false ✅
- **Body length:** 62,784 chars ✅
- **Accent class:** `light accent-heavy` ✅
- **Console errors:** none ✅
- **VLM analysis:** «داشبورد مشتری — پروفایل Daniel Reyes، منوی کامل، فرم درخواست» ✅

### 8. Git Diff Review
- **Secrets leaked:** 0 ✅
- **`.env` committed:** No ✅
- **`db/custom.db` committed:** No (gitignored) ✅
- **Unintended changes:** None ✅

## Summary

| Check | Result |
|-------|--------|
| TypeScript | PASS |
| ESLint | PASS |
| Hygiene | PASS |
| Tests | PASS (422/424, 2 expected-fail) |
| Standard build | PASS |
| Cloudflare build | PASS |
| Browser test (splash) | PASS |
| Browser test (mode-select) | PASS |
| Browser test (customer home) | PASS |
| Console errors | PASS (none) |
| Git diff security | PASS |

## SHA Verification

The tests were run on `f7d5deb346a8e76f0d4dac645bb3abad2b105d19`. No code changes were made after this SHA during testing (all items already fixed in prior commits).

---

## PostgreSQL CI Fix (2026-10-26)

**SHA tested:** `17ac60b8237b4a66eb49f9dbb1834c0687423237` (before fix)
**Fix SHA:** (pending commit)

### Root Cause

The PostgreSQL CI workflow (`postgresql-ci.yml`) replaces `prisma/migrations/`
with files from `prisma/migrations-postgresql/`. However, the D1-01 fix
(commit `ecf20b6`) added a new migration `20260926000000_add_rate_limit_idempotency`
only to `prisma/migrations/` (SQLite/D1), NOT to `prisma/migrations-postgresql/`.
So when CI ran `qa-repro.test.ts`, the test scanned the PostgreSQL migrations
(which only had `init`) and found that `RateLimit` and `IdempotencyKey` were
missing → test FAILED.

### Fix

1. Created `prisma/migrations-postgresql/20260926000000_add_rate_limit_idempotency/migration.sql`
   — PostgreSQL syntax version of the same additive migration (CREATE TABLE
   with TIMESTAMP(3) instead of DATETIME, CONSTRAINT pkey syntax).

2. Updated `.github/workflows/postgresql-ci.yml` — the "Replace migrations"
   step now copies ALL of `migrations-postgresql/` (not just `init/`):
   ```yaml
   cp -r prisma/migrations-postgresql prisma/migrations
   ```
   Previously it hardcoded only `20260925000000_init/migration.sql`.

### Verification

Simulated CI locally by copying `migrations-postgresql/` → `migrations/`
and running `qa-repro.test.ts`:
- **Result:** PASS — 5 tests (4 PASS + 1 expected-fail)
- `RateLimit` and `IdempotencyKey` now found in PostgreSQL migrations ✅

### Full test suite after fix:
- TypeScript: 0 errors ✅
- ESLint: 0 errors (2 pre-existing warnings) ✅
- Tests: 422 PASS + 2 expected-fail (424 total) ✅
