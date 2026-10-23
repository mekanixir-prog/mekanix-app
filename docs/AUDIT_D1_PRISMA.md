# MEKANIX — D1 / Prisma Audit (Task B-3)

**Agent:** D1/Prisma Engineer
**Scope:** D1/Prisma compatibility, db access layer, transactions, atomicity, concurrency, schema/migration correctness
**Working tree state at audit:** `feature/cloudflare-d1-validation @ 1cf59e7` (identical to working tree @ HEAD `23b71d2`); 29 modified files = recovered UI assets (untouched).
**Mode:** READ-ONLY. No source edits. No migrations. No remote `wrangler d1 execute`.

---

## 1. Executive Summary

The codebase has completed its **D1 migration at the access-layer level**: every consumer of `db` now goes through `getDbForLib()` (76 source files import `@/lib/db-access`, 0 source files import the synchronous `db` directly). The runtime selection logic is **real, not a stub** — `getDbForLib()` detects `navigator.userAgent === "Cloudflare-Workers"` and either returns the cached dev PrismaClient (`db.ts` / rust engine) or constructs a per-request PrismaClient wired with `@prisma/adapter-d1`'s `PrismaD1(env.DB)` adapter (`db-worker.ts:60-61`).

`$transaction`, `$executeRaw` are **never used** anywhere in `src/`. `$queryRaw` is used in exactly two places (`health/route.ts`, `ready/route.ts`) — both running the trivial `SELECT 1` ping, which is explicitly documented as D1-compatible. The team has converted every previously-transactional flow to either:
- **Atomic conditional `updateMany`** (with `WHERE` on status / prepayPaid / balance / consumed) — used in 12 places to prevent double-payment, double-verify, double-OTP-consume, double-withdraw, double-status-transition, double-wallet-release.
- **Sequential writes with documented mid-failure semantics** — used in 8 multi-step flows (payment verify, wallet withdraw, vip subscribe, mechanic approve, insurance claim, review, care booking state, care approve-extra) — each with code comments noting "D1 has no $transaction" and most with explicit mid-failure recovery notes.

**Critical blocker (BLOCKER, not WARN):** `prisma/schema.prisma` declares two models — `RateLimit` (line 1335) and `IdempotencyKey` (line 1346) — that are **NOT present in either the SQLite migration (`prisma/migrations/20260925000000_init/migration.sql`) or the PostgreSQL migration**. The Prisma Client generated against the schema will happily emit `SELECT … FROM "RateLimit"` / `INSERT INTO "IdempotencyKey"`, but the D1 database has no such tables. Code paths that touch these tables (`rate-limit.ts:81` `db.rateLimit.updateMany`, `auth.ts:463/472` `db.idempotencyKey.findUnique` / `.upsert`) are wrapped in `try/catch` and silently fall back to per-isolate in-memory state — meaning **on Cloudflare Workers production, all rate limiting silently degrades to per-isolate in-memory** (effectively no rate limit under any multi-isolate fan-out). This is the same class of bug the stale inventory explicitly claimed had been fixed ("`health/ready: $queryRaw now D1-backed (was sync stub -> always unhealthy in Workers)`").

**Other significant findings:**
- **CRITICAL (D1-03):** `auth/otp/verify/route.ts:91` does `db.user.findMany({ select: { id, phone } })` — **full-table scan of User on every OTP verify** — to support digits-only phone matching. On D1 this loads every user row into the Worker isolate on every login. Should be replaced with `findUnique` on normalized phone (which is already `@unique`) + a one-time backfill migration, or a Prisma `where: { OR: [{ phone }, ...] }` against a stored normalized field.
- **HIGH (D1-04):** `vip/subscribe/route.ts:63-68` — non-atomic read-then-write check `findFirst({ where: { paymentId, status: { in: [...] } } })` then `userVipSubscription.create`. Two concurrent subscribes with the same `paymentId` can both pass the check and both create a subscription (free-VIP bypass). Schema has no `@@unique([paymentId])` constraint. Same applies to `Job.prepayPaid` (already protected by atomic `updateMany` at `prepay/route.ts:94` — OK), and to `Review (jobId, fromUserId)` (protected by `@@unique` at schema line 445 + DB index line 1028 — OK).
- **HIGH (D1-05):** `wallets/route.ts:65-77` — the SEC-8 fix uses conditional `walletTransaction.updateMany` to win the race, but the followup `wallet.update({ pendingBalance: { decrement }, balance: { increment } })` is a **separate write**. If the second write fails (network blip, isolate eviction mid-request), the transaction row is marked `AVAILABLE` but the wallet `balance` was never credited. Money is lost from the technician's view. Recommend a compensating reconciliation query or an idempotency token on the wallet delta.
- **MEDIUM (D1-06):** `payments/route.ts:122-141` and `:169-186` — the COMPLETED flow chains 5 sequential writes (invoice.updateMany → job.updateMany → warranty.create → notification.create). If `job.updateMany` succeeds but `warranty.create` fails (caught with `.catch(() => {})`), there is NO record of the warranty being due. The customer effectively loses the warranty.
- **MEDIUM (D1-07):** No `take:` LIMIT on ~25 `findMany` calls (e.g. `dashboard/route.ts` 7 separate full-table scans per dashboard render; `support/tickets/route.ts:22` lists all tickets without pagination; `care/bookings/route.ts:133` all bookings; `service-requests/route.ts:147` all technicians). D1 returns up to 5 MB / 100k rows per query but CPU-time-bound Worker isolates will OOM/timeout first.
- **MEDIUM (D1-08):** `support/tickets/route.ts:81-98` — N+1 insert loop: one `notification.create` per admin. Should be `notification.createMany` (D1 supports it via the adapter for plain inserts).

The DB access layer architecture is sound and correctly implements per-request PrismaClient caching (`db-worker.ts:54-64`, keyed by `Symbol.for("mekanix.prismaClient")` on the OpenNext context). Generator config is missing `previewFeatures` — `@prisma/adapter-d1` requires `previewFeatures = ["driverProviders"]` in some Prisma 6.x versions; the current config works only because the build script (`build-cloudflare.sh:92`) injects `engineType = "client"` at build time. Without that injection, Prisma would emit `engineType` warnings and could refuse to wire the adapter at runtime.

**Schema provider:** `sqlite` (line 18). This is correct for D1 (D1 is wire-compatible with SQLite). The PostgreSQL migration dir exists for the future "switch to Postgres" path but is **NOT** used by the D1 deployment.

---

## 2. Real db-access Inventory Table (and diff vs stale `d1-migration-inventory.json`)

### 2.1 Direct db import inventory (current reality)

**Direct synchronous `db` import from `@/lib/db`:**
| File | Status |
| --- | --- |
| _(none)_ | ✅ ZERO source files in `src/` import the synchronous `db` directly |

The only file that even mentions the old pattern is `src/lib/db.worker.ts:15` — a comment ("The 63 consumers of sync `db` continue to import from `@/lib/db`"). That comment is stale — the migration to `getDbForLib()` is complete.

**Async `getDbForLib()` consumers (76 files):**

API routes (63 files):
```
src/app/api/admin-panel/auth/login/route.ts            src/app/api/mechanic-applications/route.ts
src/app/api/admin-panel/auth/me/route.ts               src/app/api/mechanic-applications/[id]/approve/route.ts
src/app/api/admin-panel/onboarding/route.ts            src/app/api/mechanic-applications/[id]/reject/route.ts
src/app/api/admin-panel/onboarding/[id]/route.ts       src/app/api/messages/route.ts
src/app/api/admin/[resource]/route.ts                 src/app/api/notifications/route.ts
src/app/api/admin/[resource]/[id]/route.ts            src/app/api/notifications/[id]/route.ts
src/app/api/auth/demo/route.ts                        src/app/api/onboarding/route.ts
src/app/api/auth/otp/send/route.ts                    src/app/api/payments/route.ts
src/app/api/auth/otp/verify/route.ts                  src/app/api/prepay/route.ts
src/app/api/auth/session/route.ts                     src/app/api/ready/route.ts
src/app/api/care/admin/packages/route.ts              src/app/api/referral/route.ts
src/app/api/care/admin/rules/route.ts                 src/app/api/reviews/route.ts
src/app/api/care/bookings/[id]/approve-extra/route.ts src/app/api/service-requests/route.ts
src/app/api/care/bookings/[id]/extra-proposal/route.ts src/app/api/service-requests/[id]/assign/route.ts
src/app/api/care/bookings/[id]/findings/route.ts      src/app/api/support/tickets/route.ts
src/app/api/care/bookings/[id]/health-report/route.ts src/app/api/technicians/route.ts
src/app/api/care/bookings/[id]/inspection/route.ts    src/app/api/technicians/[id]/route.ts
src/app/api/care/bookings/[id]/reject-extra/route.ts  src/app/api/vehicles/route.ts
src/app/api/care/bookings/[id]/route.ts               src/app/api/vehicles/[id]/route.ts
src/app/api/care/bookings/[id]/timeline/route.ts      src/app/api/vip/my/route.ts
src/app/api/care/bookings/route.ts                    src/app/api/vip/plans/route.ts
src/app/api/care/packages/route.ts                    src/app/api/vip/subscribe/route.ts
src/app/api/care/technician/missions/route.ts         src/app/api/wallets/route.ts
src/app/api/care/technician/missions/[id]/route.ts    src/app/api/wallets/withdraw/route.ts
src/app/api/care/vehicles/[id]/health/route.ts        src/app/api/dashboard/route.ts
src/app/api/care/vehicles/[id]/maintenance/route.ts   src/app/api/exchange-rate/route.ts
src/app/api/gateway/initiate/route.ts                 src/app/api/health/route.ts
src/app/api/gateway/verify/route.ts                  src/app/api/insurance/claim/route.ts
src/app/api/invoices/route.ts                        src/app/api/insurance/route.ts
src/app/api/invoices/[id]/route.ts                   src/app/api/jobs/route.ts
src/app/api/jobs/[id]/diagnosis/route.ts              src/app/api/jobs/[id]/parts/route.ts
src/app/api/jobs/[id]/route.ts                       src/app/api/jobs/[id]/status/route.ts
src/app/api/maintenance/route.ts
```

Lib files (12 files):
```
src/lib/admin-api.ts       src/lib/pricing.ts          src/lib/db-access.ts (definition)
src/lib/admin-auth.ts      src/lib/rate-limit.ts       src/lib/db-worker.ts (definition)
src/lib/auth.ts            src/lib/service-unified.ts  src/lib/db.worker.ts (build-time swap target)
src/lib/care-auth.ts       src/lib/service-write.ts    src/lib/init.ts (does not use getDbForLib — env detection only)
src/lib/dispatch.ts        src/lib/vip.ts              src/lib/notifications.ts
```

Total: **76 unique files import `getDbForLib` from `@/lib/db-access`**, plus 3 definition files (`db-access.ts`, `db-worker.ts`, `db.worker.ts`) that are part of the access layer itself.

### 2.2 Diff vs stale `docs/d1-migration-inventory.json`

The stale inventory (generated_at "2026-10-12") claims:

| Stale inventory claim | Reality (verified by grep on current code) | Discrepancy |
| --- | --- | --- |
| `migrated_files: 70` | 76 files import `getDbForLib` from `@/lib/db-access` | Stale undercount by 6 files |
| `remaining_files: 7` (with `db_calls: 26`) | **0 remaining files** — every consumer uses `getDbForLib()` | Stale inventory lists 7 "remaining" files that have actually all been migrated |
| `src/lib/db-sequential.ts` (P4-lib, used by `jobs/[id]/status`) | **File does not exist.** `jobs/[id]/status/route.ts` uses `getDbForLib()` directly with inline `updateMany` (line 152). | Phantom file — the inventory is wrong. |
| `src/app/api/admin-panel/auth/login/route.ts` — "remaining" | File at line 37 calls `await getDbForLib()` | Listed as remaining but actually migrated |
| `src/app/api/admin-panel/auth/me/route.ts` — "remaining" | Line 8 calls `await getDbForLib()` | Listed as remaining but actually migrated |
| `src/app/api/admin-panel/onboarding/route.ts` — "remaining" | Lines 9, 18 call `await getDbForLib()` | Listed as remaining but actually migrated |
| `src/app/api/admin-panel/onboarding/[id]/route.ts` — "remaining" | Lines 41, 72 call `await getDbForLib()` | Listed as remaining but actually migrated |
| `src/app/api/admin/[resource]/route.ts` — "remaining" | Line 74 calls `await getDbForLib()` | Listed as remaining but actually migrated |
| `src/app/api/admin/[resource]/[id]/route.ts` — "remaining" | Line 85 calls `await getDbForLib()` | Listed as remaining but actually migrated |
| `migrated_lib_files`: lists 11 lib files | Actual: 12 lib files (adds `notifications.ts` which was omitted from stale list) | Stale undercount |
| `security_fixes_during_p3`: lists 5 fixes | All 5 still present and verifiable in source | PASS |
| `constraints_maintained`: "no remote D1 migration, no deploy" | Still true at audit time | PASS |

**Conclusion:** The stale inventory under-counts migration progress (claims 7 unmigrated files; reality is 0). It also references a phantom file (`src/lib/db-sequential.ts`) that does not exist in the codebase. **The migration is actually COMPLETE at the access-layer level** — but new gaps have emerged (see §7: missing `RateLimit` / `IdempotencyKey` tables in migrations).

---

## 3. DB Access Layer Architecture

### 3.1 File responsibilities

| File | Purpose | Used in Workers runtime? | Used in dev? |
| --- | --- | --- | --- |
| `src/lib/db.ts` | Standard `PrismaClient` (rust engine), cached on `globalThis.prisma` for HMR. | ❌ No — replaced by `db.worker.ts` at build time via `scripts/build-cloudflare.sh:113` (`cp db.worker.ts db.ts`). Restored after build via `cleanup` trap (line 50-53). | ✅ Yes — this is the dev entry point. |
| `src/lib/db.worker.ts` | Build-time replacement for `db.ts`. In Workers: emits a Proxy that throws on any property access (`Workers: sync db.X not supported`). In Node.js build (with `engineType="client"` injected): constructs `PrismaClient({ adapter: mockAdapter })` to satisfy the "adapter required" check during OpenNext's page-data collection. Re-exports `getDb` from `./db-worker`. | ✅ Yes — only this file is present at build time, but it does not provide the runtime D1 access — it just throws and points consumers to `getDb()`. | ❌ No. |
| `src/lib/db-worker.ts` | **The real D1 access layer.** Exports `getDb()` which lazily imports `getCloudflareContext` from `@opennextjs/cloudflare`, reads `env.DB` (D1 binding), constructs `new PrismaD1(env.DB)` adapter and `new PrismaClient({ adapter })`. Per-request cached on the OpenNext context object via `Symbol.for("mekanix.prismaClient")`. | ✅ Yes — this is the file that actually wires `@prisma/adapter-d1`. | ❌ No (would throw — `getCloudflareContext` is undefined in dev). |
| `src/lib/db-access.ts` | Environment dispatcher. Exports `getDbForLib(): Promise<PrismaClient>`. Detects Workers via `navigator.userAgent === "Cloudflare-Workers"`. In Workers: returns `getDb()` (from `db-worker.ts`). In dev: returns cached sync `db` (from `db.ts`). | ✅ Indirectly — delegates to `db-worker.ts`. | ✅ Indirectly — delegates to `db.ts`. |
| `src/lib/init.ts` | Server bootstrap. Detects Workers via `typeof caches !== 'undefined' && !process.versions.node`. In dev only: dynamically imports + initializes ETA provider + SMS provider. No DB logic. | N/A (skipped in Workers). | ✅ Side-effect init only. |

### 3.2 Runtime selection logic (with evidence)

```
                  ┌─────────────────────────────────────────────────┐
                  │ Consumer code: `const db = await getDbForLib();`  │
                  │ (76 source files use this pattern)               │
                  └─────────────────────────────────────────────────┘
                                          │
                                          ▼
        ┌───────────────────────────────────────────────────────────┐
        │ db-access.ts:22-23  const isCloudflareWorkers =          │
        │   typeof navigator !== "undefined" &&                     │
        │   navigator.userAgent === "Cloudflare-Workers"            │
        └───────────────────────────────────────────────────────────┘
                                          │
              ┌───────────────────────────┴───────────────────────────┐
              ▼ (Workers)                                              ▼ (Node.js dev)
   ┌──────────────────────────────┐                       ┌───────────────────────────────┐
   │ db-access.ts:39-40           │                       │ db-access.ts:44-48             │
   │ const { getDb } =            │                       │ if (!devDb) {                  │
   │   await import("./db-worker")│                       │   const { db } =               │
   │ return getDb();              │                       │     await import("./db");      │
   └──────────────────────────────┘                       │   devDb = db;                  │
              │                                          │ }                              │
              ▼                                          │ return devDb;                  │
   ┌──────────────────────────────┐                       └───────────────────────────────┘
   │ db-worker.ts:39-67           │                                     │
   │ - getCloudflareContext()     │                                     ▼
   │ - env.DB (D1 binding)        │                       ┌───────────────────────────────────┐
   │ - new PrismaD1(env.DB)       │                       │ db.ts:8  new PrismaClient({        │
   │ - new PrismaClient({adapter})│                       │   log: ["error","warn"] })        │
   │ - cache on ctx[Symbol]       │                       │ (rust query engine, file: SQLite) │
   └──────────────────────────────┘                       └───────────────────────────────────┘
```

### 3.3 Key questions answered

| Question | Answer | Evidence |
| --- | --- | --- |
| Which file is used in Workers runtime? | `db-worker.ts` (via `db-access.ts` dispatch) | `db-access.ts:37-41` calls `getDb()` from `db-worker` |
| Is `getDbForLib()` real or a stub? | **Real.** Detects env, returns a live `PrismaClient` in both modes. | `db-access.ts:36-49` |
| Is `@prisma/adapter-d1` actually wired? | **Yes.** `db-worker.ts:16` imports `PrismaD1`; `db-worker.ts:60-61` constructs `new PrismaD1(env.DB)` + `new PrismaClient({ adapter })`. | Confirmed in `package.json:31` `"@prisma/adapter-d1": "6.19.3"` |
| Is there a SQLite/D1 fallback vs Postgres path? | **No Postgres path in code.** Schema `provider = "sqlite"` (line 18). Migration lock `prisma/migrations/migration_lock.toml` says `provider = "sqlite"`. Postgres migration dir exists but is unused (lock says `postgresql` but no code reads it). | Schema, lock files |
| Is per-request PrismaClient caching correct? | **Yes.** Cached on OpenNext context object via `Symbol.for("mekanix.prismaClient")`. The context object is the same across `getCloudflareContext()` calls within one HTTP request (per OpenNext docs). | `db-worker.ts:54-64` |
| Does the build-time swap correctly restore `db.ts`? | **Yes** — `scripts/build-cloudflare.sh:72` registers a `trap cleanup EXIT` that restores `db.ts` from `db.ts.bak` even on failure (line 50-53). | `build-cloudflare.sh:34-69` |

---

## 4. `$transaction` / Raw Query Inventory

### 4.1 `$transaction` (sequential & interactive)

| File:Line | Pattern | D1 Risk | Recommended Replacement |
| --- | --- | --- | --- |
| _(none)_ | — | — | — |

**Zero `$transaction` usages found** in `src/`. The codebase has been fully migrated away from `$transaction` to either atomic conditional `updateMany` or sequential writes with documented mid-failure semantics. **D1-incompatible count: 0.**

### 4.2 `$queryRaw` / `$executeRaw`

| File:Line | Pattern | D1 Risk | Recommended Replacement |
| --- | --- | --- | --- |
| `src/app/api/health/route.ts:18` | `await db.$queryRaw\`SELECT 1\`` | **LOW** — D1 adapter implements `queryRaw` by routing through `D1Database.prepare("SELECT 1").all()` (verified in code comment lines 7-12). | None needed — this is the recommended D1-compatible ping. |
| `src/app/api/ready/route.ts:13` | `await db.$queryRaw\`SELECT 1\`` | **LOW** — same as above. Comment at line 5 refers to health/route.ts. | None needed. |

**`$executeRaw` usages: 0.** Raw SQL writes are not used anywhere; all writes go through Prisma's typed API, which the adapter translates to parameterized D1 statements.

### 4.3 Other D1-incompatible patterns

| File:Line | Pattern | D1 Risk | Notes |
| --- | --- | --- | --- |
| `src/lib/dispatch.ts:207` | `db.dispatchCandidate.createMany({ data: [...] })` | **LOW-MEDIUM** — `@prisma/adapter-d1@6.19.3` supports `createMany` for plain inserts (no nested writes). Should work, but unverified at runtime. | Test in staging before relying on it. Alternative: `Promise.all(candidates.map(c => db.dispatchCandidate.create({ data: c })))` — slower but guaranteed compatible. |
| `src/lib/auth.ts:463` `:472` | `db.idempotencyKey.findUnique` / `.upsert` | **CRITICAL** — `IdempotencyKey` table does not exist in D1 migration. Code has try/catch fallback to in-memory store, so it degrades silently. | See finding D1-01. |
| `src/lib/rate-limit.ts:81` `:96` | `db.rateLimit.updateMany` / `.upsert` | **CRITICAL** — `RateLimit` table does not exist in D1 migration. Silent fallback to in-memory. | See finding D1-01. |
| `src/app/api/auth/otp/verify/route.ts:91` | `db.user.findMany({ select: { id, phone } })` — full-table scan to support digits-only phone matching | **HIGH** — O(N) per login attempt, where N = total User rows. On D1 this will be the dominant cost in Worker CPU time for any non-trivial user base. | See finding D1-03. |

### 4.4 JSON field reads/writes

Several models store JSON in `String` columns (e.g. `MechanicApplication.specialties`, `MechanicApplication.certifications`, `VehicleHealthReport.categories`, `VehicleHealthReport.evidence`, `PartUsage.evidence`, `CareSubscription.benefits`, `CareReminder.notificationSchedule`). Code reads/writes these via `JSON.parse(...)` / `JSON.stringify(...)` at the application layer — no `Json` Prisma type is used. This is **D1-safe** (D1 stores TEXT natively). No issue.

---

## 5. Multi-step Op Atomicity Table

For each financial/state flow: list the sequential writes, the failure window, and the recommended idempotency fix.

| Flow | File:Line | Steps | Failure Window (between steps) | Idempotency Recommendation |
| --- | --- | --- | --- | --- |
| **Payment gateway verify** | `gateway/verify/route.ts:49-74` | (1) `paymentGatewayLog.updateMany({ where: { id, status: { not: "VERIFIED" } } })` — atomic, count-check protects double-verify. (2) `payment.create` — primary record. (3) `paymentGatewayLog.update({ paymentId })` — links log to payment. | **(2)→(3):** If `payment.create` succeeds but the linking `update` fails, the Payment exists but is not linked to its gateway log. A re-verify call will hit step (1)'s `count===0` path and return "Already verified" without re-creating the payment — so the orphan Payment stays unlinked. | Add `paymentId` to the step (1) `updateMany` data (set both `status: "VERIFIED"` AND `paymentId` in a single atomic update) — then step (3) becomes redundant. |
| **Wallet withdraw** | `wallets/withdraw/route.ts:82-137` | (1) `wallet.updateMany({ where: { id, balance: { gte: amount } }, data: { balance: { decrement: amount } } })` — atomic. (2) Re-read `wallet.findUnique` for actual balance. (3) `withdrawalRequest.create`. (4) `walletLedger.create`. (5) `notification.create`. | **(1)→(3):** If the atomic decrement succeeds but `withdrawalRequest.create` fails (DB error, isolate evicted), the wallet balance is deducted but no withdrawal request exists — a "lost funds" scenario from the technician's view. The code comment (lines 64-69) acknowledges this and says "admin can reconcile" — acceptable but not self-healing. **(3)→(4):** If `withdrawalRequest.create` succeeds but `walletLedger.create` fails, the WithdrawalRequest exists without a ledger entry — breaks audit trail. | Add an `idempotencyKey` to the WithdrawalRequest model (e.g., `walletId + amount + balanceBefore + nonce`) and use `upsert` instead of `create`. On retry, the dedup key returns the existing request and skips the balance decrement. Currently the WithdrawalRequest has `code` (`@unique`) but `code` is randomly generated per call (`WD-${Math.floor(100000 + Math.random() * 900000)}`), so it does NOT serve as an idempotency key. |
| **VIP subscribe** | `vip/subscribe/route.ts:63-89` | (1) `userVipSubscription.findFirst({ where: { paymentId, status: { in: [...] } } })` — non-atomic check. (2) `userVipSubscription.updateMany({ where: { userId, status: "ACTIVE" }, data: { status: "CANCELLED" } })` — atomic cancel existing. (3) `userVipSubscription.create` — primary. (4) `notification.create` (best-effort, try/catch). | **(1)→(3):** Two concurrent subscribes with the same `paymentId` can both pass step (1)'s `findFirst` check (no row yet exists) and both create a subscription — free-VIP bypass. **(2)→(3):** If cancel-existing succeeds but create fails, the user is left with NO active subscription (their existing one was cancelled but no new one created). | Add `@@unique([paymentId])` to `UserVipSubscription` schema (or `@@unique([paymentId, userId])` if NULLs are involved) so the DB rejects the duplicate. Wrap step (2)+(3) into a single conditional transaction with a `paymentId` precondition. |
| **Pre-service payment (prepay)** | `prepay/route.ts:94-204` | (1) `job.updateMany({ where: { id, prepayPaid: false }, data: { prepayPaid: true, ...fees } })` — atomic double-payment protection. (2) `wallet.create` if not exists. (3) `walletTransaction.create` (PREPAY). (4) `walletTransaction.create` (COMMISSION). (5) `wallet.update({ pendingBalance: { increment }, totalEarned: { increment }, ... })`. (6) 2× `notification.create`. (7) `message.create`. | **(1)→(5):** If the job is marked `prepayPaid: true` (step 1) but `wallet.update` (step 5) fails, the customer is charged (job shows prepaid) but the technician's `pendingBalance` was never incremented. Money is lost from the technician's view. | After step (1), the side-effects (3-7) are recoverable on retry by checking `job.prepayPaid === true`. Add a reconciliation cron (or a check at wallet GET) that scans for `prepayPaid: true` jobs with missing `WalletTransaction` rows and creates them. Currently no such reconciliation exists. |
| **Job status → COMPLETED side-effects** | `jobs/[id]/status/route.ts:152-200` | (1) `job.updateMany({ where: { id, status: existing.status }, data: { status: "COMPLETED", completedAt } })` — atomic. (2) `walletTransaction.updateMany({ where: { jobId, status: "PENDING" }, data: { holdUntil } })` — sets 12h hold. (3) `notification.create`. (4) `message.create`. | **(1)→(2):** If job is COMPLETED but the hold-until update fails, the walletTransaction stays PENDING with `holdUntil: null` — the auto-release at `wallets/route.ts:53` filters on `t.holdUntil && t.holdUntil.getTime() < now.getTime()`, so a `null holdUntil` means the transaction is NEVER auto-released. Technician funds stuck forever. | Either (a) change the auto-release filter to also release PENDING txns older than `HOLD_HOURS` regardless of `holdUntil` (compute holdUntil from `createdAt`), or (b) make step (2) idempotent + retryable. |
| **Job status → WAITING_APPROVAL invoice issuance** | `jobs/[id]/status/route.ts:287-307` | (1) `job.updateMany({ where: { id, status: existing.status } })` — atomic status transition. (2) `notification.create`. (3) `message.create`. (4) `invoice.create` (only if `!job.invoice` — but `job` was read at line 165 AFTER the status update, so the invoice check is post-update state). | **(1)→(4):** If job is WAITING_APPROVAL but `invoice.create` fails, the job is stuck in WAITING_APPROVAL without an invoice. Customer cannot pay. | Schema already has `Invoice.jobId @unique` (line 379) + DB index `Invoice_jobId_key` (migration line 1019) — so a retry is safe. Add a reconciliation check: on `GET /api/invoices?jobId=X` (no invoice found), if `job.status === "WAITING_APPROVAL"`, auto-create the missing invoice. |
| **Payment record + invoice + job + warranty** | `payments/route.ts:114-141` and `:162-186` | (1) `invoice.updateMany({ where: { id, status: { not: "PAID" } }, data: { status: "PAID" } })` — atomic. (2) `job.updateMany({ where: { id, status: { not: "COMPLETED" } }, data: { status: "COMPLETED", completedAt } })` — atomic. (3) `warranty.create({ data: { jobId } })` — **caught with `.catch(() => {})` — silent failure**. (4) `notification.create`. | **(2)→(3):** If `job.updateMany` succeeds but `warranty.create` fails (silent catch), the job is COMPLETED without a warranty record. Customer loses the 6-month warranty entitlement. The `.catch(() => {})` swallow at line 128/174 means no log, no alert, no retry. | Replace `.catch(() => {})` with `.catch(e => console.error(...))` at minimum. Better: add an `IdempotencyKey`-style dedup on `Warranty.jobId` (already `@unique` at schema line 485) and retry on next payment-related call. Currently the warranty is silently lost. |
| **Mechanic application approve** | `mechanic-applications/[id]/approve/route.ts:38-117` | (1) `mechanicApplication.findUnique` (status check). (2) `user.findUnique` → `user.create` OR `user.update`. (3) `technician.findUnique` → `technician.create`. (4) `mechanicApplication.update({ status: "APPROVED", reviewerId, ... })`. (5) `notification.create` (best-effort). | **(2)+(3)→(4):** If user/tech are created but the application status update fails, a re-approve call will find the user+tech already exist (via `findUnique` at lines 43, 59) and skip creation, then retry the status update. **The code comment at lines 16-21 documents this — well designed.** | PASS. The findUnique-then-create pattern is idempotent by design. |
| **Insurance claim** | `insurance/claim/route.ts:81-117` | (1) `insuranceClaim.create` — primary. (2) `insurancePolicy.update({ status: "claimed" })` — best-effort try/catch. (3) `notification.create` — best-effort. | **(1)→(2):** If claim is created but policy status update fails, the claim exists but the policy still shows "active". A second claim against the same policy could succeed. | The code comment (lines 18-23) acknowledges this and recommends admin reconciliation — acceptable. For D1-safe hardening: use `insurancePolicy.updateMany({ where: { id, status: "active" }, data: { status: "claimed" } })` and check count to prevent double-claim. |
| **Review + technician rating recompute** | `reviews/route.ts:74-96` | (1) `review.findFirst({ where: { jobId, fromUserId } })` — non-atomic duplicate check. (2) `review.create`. (3) `review.findMany({ where: { technicianId } })` — full recompute. (4) `technician.update({ rating, reviewCount, completedJobs: { increment } })`. | **(1)→(2):** Two concurrent reviews from the same user on the same job can both pass `findFirst` and both call `create`. The schema's `@@unique([jobId, fromUserId])` (line 445) + DB index (migration line 1028) will cause the second `create` to throw P2002 — but the route does NOT handle that error, so it returns 500. **(3)→(4):** Two concurrent reviews by different users on the same technician will both fetch all reviews, both compute avg, both `technician.update` — last write wins, the earlier review's contribution to the avg is overwritten (transient staleness, self-corrects on next review). | Catch P2002 specifically and return 409 Conflict. Replace steps (3)+(4) with an atomic SQL `UPDATE technician SET rating = (SELECT AVG(rating) FROM Review WHERE technicianId = ?), reviewCount = (SELECT COUNT(*) FROM Review WHERE technicianId = ?)` — but D1 raw SQL is more complex; alternatively use `aggregate({ _avg, _count })` and only write if the new value differs. |
| **Care booking creation** | `care/bookings/route.ts:88-122` | (1) `serviceBooking.create`. (2) `pricingSnapshot.create`. (3) `serviceBooking.update({ pricingSnapshotId })`. (4) `serviceTimelineEvent.create`. | **(1)→(3):** If booking is created but snapshot linking fails, the booking has no pricing snapshot — `pricingVersion` field on the booking may be `null`. Affects audit trail. | Move `pricingSnapshot.create` BEFORE `serviceBooking.create` and pass `pricingSnapshotId` in the booking create — single-step atomic link. |
| **Care booking approve-extra** | `care/bookings/[id]/approve-extra/route.ts:102-132` | (1) `customerApproval.update({ status: "CUSTOMER_APPROVED" })`. (2) `finding.update({ status: "APPROVED" })` (conditional). (3) `serviceBooking.update({ status: "APPROVED" })`. (4) `serviceTimelineEvent.create`. | **(1)→(3):** If approval is set to CUSTOMER_APPROVED but booking status update fails, the approval is approved but the booking is still WAITING_CUSTOMER_APPROVAL — inconsistent state. | Use `customerApproval.updateMany({ where: { id, status: "PROPOSED" }, data: { status: "CUSTOMER_APPROVED" } })` and check count, then use `serviceBooking.updateMany({ where: { id, status: "WAITING_CUSTOMER_APPROVAL" }, data: { status: "APPROVED" } })` and check count. If either count is 0, the state has already moved — return 409 without partial writes. |
| **Care mission status update** | `care/technician/missions/[id]/route.ts:80-94` | (1) `serviceBooking.updateMany({ where: { id, status: existing.status }, data: { status } })` — atomic. (2) `serviceTimelineEvent.create`. | **(1)→(2):** If status update succeeds but timeline event create fails, the booking has a new status but no timeline record of the transition — audit gap. | Acceptable for non-financial state. Add retry-on-next-call: on `GET /api/care/technician/missions/[id]`, check if latest timeline event matches current status; if not, backfill. |
| **Care inspection upsert** | `care/bookings/[id]/inspection/route.ts:37-60` | (1) `inspection.upsert({ where: { bookingId }, create: ..., update: ... })`. (2) `serviceTimelineEvent.create`. | **(1)→(2):** If upsert succeeds but timeline event fails, no audit record of the inspection start. | Acceptable — non-financial. |
| **Care health-report** | `care/bookings/[id]/health-report/route.ts:43-83` | (1) `vehicleHealthReport.upsert({ where: { bookingId } })`. (2) `vehicleCareProfile.updateMany({ where: { vehicleId, ... } })`. | **(1)→(2):** If health report is upserted but care profile is not updated, the care profile's `healthScore` is stale. | Acceptable — self-corrects on next inspection. |
| **Wallet auto-release** | `wallets/route.ts:65-77` | (1) `walletTransaction.updateMany({ where: { id, status: "PENDING" }, data: { status: "AVAILABLE", releasedAt } })` — atomic. (2) `wallet.update({ pendingBalance: { decrement }, balance: { increment } })`. | **(1)→(2):** If transaction row is marked AVAILABLE but the wallet balance update fails, the transaction is AVAILABLE but the technician's balance was never credited — **lost funds**. | See finding D1-05. Recommendation: combine into a single conditional update via `wallet.updateMany({ where: { id: wallet.id, pendingBalance: { gte: t.netAmount } }, data: { pendingBalance: { decrement }, balance: { increment } } })` and check count — but this still doesn't make the two writes atomic together. The proper D1-safe pattern is to record the wallet delta as a `WalletLedger` row (already exists in schema) and compute `balance` on read (slow) or via a periodic reconciliation cron (deferred but eventually consistent). |
| **OTP send** | `auth/otp/send/route.ts:77-78` | (1) `otpCode.updateMany({ where: { phone, consumed: false }, data: { consumed: true } })` — invalidate prior codes. (2) `otpCode.create` — new code. | **(1)→(2):** If invalidation succeeds but new code create fails, the user has no valid code AND no prior codes — they must wait for the next rate-limit window. | Acceptable — user can retry after rate-limit window. |
| **OTP verify (consume + user create/find + session)** | `auth/otp/verify/route.ts:67-149` | (1) `otpCode.updateMany({ where: { phone, code, consumed: false, expiresAt: { gt: now } }, data: { consumed: true } })` — atomic. (2) `user.findUnique` / `user.create` / `user.update` (with conditional customer.create). (3) `session.create` (in `createSession()` from auth.ts). | **(1)→(3):** If OTP is consumed but session.create fails, the OTP is now invalid (cannot be reused) but the user has no session. They must request a new OTP. Annoying but not insecure. | Acceptable for dev. In production, the auth.ts:121-127 fail-closed (throws if session.create fails in prod) means the user gets a 500 — but the OTP is already consumed. Fix: use a 2-phase consume — first verify (read-only), then atomically consume + create session in a single conditional `updateMany`. Currently the consume happens BEFORE user lookup, which is suboptimal. |
| **Auth session create** | `auth.ts:108-131` | (1) `session.create({ userId, tokenHash, device, ip, expiresAt })`. | Single step — atomic. PASS. The fail-closed behavior in production (line 123-127 throws if session.create fails) is correct. | PASS. |
| **Auth session revoke** | `auth.ts:196-199` `:214-217` | (1) `session.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } })`. | Single atomic conditional update — idempotent (revokedAt: null filter means second call is no-op). PASS. | PASS. |
| **Mechanic application reject** | `mechanic-applications/[id]/reject/route.ts:20-?` | (1) `mechanicApplication.update({ status: "REJECTED", ... })`. | Single step. PASS. | PASS. |

---

## 6. Concurrency / Race Findings

| File:Line | Race | Severity | Fix |
| --- | --- | --- | --- |
| `vip/subscribe/route.ts:63-68` + `:79-89` | Non-atomic `findFirst(paymentId)` → `create(paymentId)` allows double-VIP-subscribe from one payment | **HIGH** | Add `@@unique([paymentId])` to `UserVipSubscription` (or `@@unique([paymentId, status])`). Catch P2002 and return 409. |
| `wallets/route.ts:65-77` | `walletTransaction.updateMany` (count=1) is atomic, but the followup `wallet.update` is a separate write — if it fails, balance is not credited despite the txn being AVAILABLE | **HIGH** | See D1-05. Combine the credit into the same atomic op via `wallet.updateMany({ where: { id: wallet.id, pendingBalance: { gte: t.netAmount } }, ... })` with count-check; OR write to `walletLedger` first (audit row), then update wallet balance on read (eventual consistency). |
| `payments/route.ts:128, :174` | `warranty.create({ data: { jobId } }).catch(() => {})` — silent failure means lost warranty | **MEDIUM** | Replace `.catch(() => {})` with `.catch(e => console.error("[payments] warranty.create failed for job:", jobId, e))`. Schema `Warranty.jobId @unique` means retry is safe — add reconciliation in a cron or on next payment-related read. |
| `reviews/route.ts:69-84` | Non-atomic `findFirst(jobId, fromUserId)` → `review.create` race — schema `@@unique([jobId, fromUserId])` will throw P2002 on the loser, but the route does NOT handle it (returns 500) | **MEDIUM** | Catch `Prisma.PrismaClientKnownRequestError` with code `P2002` and return 409 Conflict. |
| `rate-limit.ts:81-105` | The D1 conditional `updateMany` IS atomic — but only if the `RateLimit` table exists. Currently it doesn't (D1-01). In Workers production, every rate-limited call falls back to in-memory (per-isolate) — **rate limiting is effectively bypassed across isolates**. | **CRITICAL** | Add the `RateLimit` and `IdempotencyKey` tables to the D1 migration. |
| `auth/otp/verify/route.ts:91-109` | `db.user.findMany({ select: { id, phone } })` — full-table scan, then JS-side digits-only matching. Two concurrent verifies by different users trigger two full-table scans. | **HIGH** (performance, not correctness) | See D1-03. Replace with `db.user.findUnique({ where: { phone } })` against the normalized phone; if no match, fall back to digits-only by indexing a stored `phoneDigits` column. |
| `wallets/withdraw/route.ts:82-90` | The atomic decrement is correct (uses `balance: { gte: amount }` precondition). PASS for the decrement itself. The race window is between decrement and `withdrawalRequest.create` (see D1-05 row in §5). | **MEDIUM** | See D1-05. |
| `care/bookings/[id]/approve-extra/route.ts:102-122` | `customerApproval.update` (no `where` status precondition) → `serviceBooking.update` (no precondition) — both unconditional, can race | **MEDIUM** | Convert to `updateMany` with status preconditions: `customerApproval.updateMany({ where: { id, status: "PROPOSED" }, ... })` and `serviceBooking.updateMany({ where: { id, status: "WAITING_CUSTOMER_APPROVAL" }, ... })`. Check counts; if 0, return 409. |
| `care/technician/missions/[id]/route.ts:80-94` | Correctly uses `serviceBooking.updateMany({ where: { id, status: existing.status } })` with count-check → 409 on race. PASS. | PASS | — |
| `prepay/route.ts:94-105` | Correctly uses `job.updateMany({ where: { id, prepayPaid: false } })` with count-check. PASS. | PASS | — |
| `jobs/[id]/status/route.ts:152-162` | Correctly uses `job.updateMany({ where: { id, status: existing.status } })` with count-check → 409. PASS. | PASS | — |
| `auth/otp/verify/route.ts:67-79` | Correctly uses `otpCode.updateMany({ where: { phone, code, consumed: false, expiresAt: { gt: now } } })` with count-check. PASS — this is the SEC-10 fix. | PASS | — |
| `auth/otp/send/route.ts:77` | Correctly uses `otpCode.updateMany({ where: { phone, consumed: false }, data: { consumed: true } })` to invalidate prior codes before creating a new one. PASS. | PASS | — |
| `payments/route.ts:114, :122, :162, :169` | Correctly uses conditional `updateMany` with status preconditions for `invoice.status: { not: "PAID" }` and `job.status: { not: "COMPLETED" }`. PASS. | PASS | — |
| `gateway/verify/route.ts:49-52` | Correctly uses `paymentGatewayLog.updateMany({ where: { id, status: { not: "VERIFIED" } } })` with count-check. PASS — atomic double-verify protection. | PASS | — |
| `auth.ts:196-217` | `session.updateMany({ where: { tokenHash/userId, revokedAt: null } })` — idempotent. PASS. | PASS | — |
| `service-write.ts:268, :328` | Correctly uses `updateMany` with status precondition for booking/job transitions. PASS. | PASS | — |
| `vip.ts:58-60` | Correctly uses `userVipSubscription.updateMany({ where: { userId, status: "ACTIVE" } })` to cancel existing before create. PASS for the cancel step (but see the create race in `vip/subscribe/route.ts:79`). | PASS (cancel step) | See D1-04. |

---

## 7. Schema / Migration Findings

### 7.1 Generator config (`prisma/schema.prisma:9-12`)

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]
}
```

| Field | Value | D1-relevant? | Notes |
| --- | --- | --- | --- |
| `provider` | `prisma-client-js` | — | Standard. |
| `binaryTargets` | `["native", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]` | LOW | Used by the rust query engine in dev. In Workers, the build script (`build-cloudflare.sh:92`) injects `engineType = "client"` which switches to the JS-only client that uses the driver adapter — `binaryTargets` is then irrelevant at runtime but still needed at build time so the dev client works. |
| `previewFeatures` | _(absent)_ | **MEDIUM** | For `@prisma/adapter-d1` in Prisma 6.x, some versions require `previewFeatures = ["driverProviders"]` (older) or `["postgresqlExtensions"]` etc. The current config works only because `engineType = "client"` is injected at build time. If a future Prisma upgrade changes the default `engineType` behavior, the adapter may not wire correctly. **Recommendation:** add `previewFeatures = ["driverProviders"]` explicitly to make the intent visible and resilient. |

### 7.2 Datasource (`prisma/schema.prisma:14-20`)

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

| Field | Value | D1-relevant? | Notes |
| --- | --- | --- | --- |
| `provider` | `sqlite` | ✅ Correct | D1 is SQLite wire-compatible. |
| `url` | `env("DATABASE_URL")` | ✅ | In dev: `file:./db/custom.db`. In Workers: not used (the `PrismaD1` adapter bypasses `url` and uses `env.DB` binding directly). |

### 7.3 Migration directories

| Directory | Lock provider | Used by D1? | Notes |
| --- | --- | --- | --- |
| `prisma/migrations/` | `sqlite` | ✅ Canonical for D1 | Contains `20260925000000_init/migration.sql` (1215 lines, 58 `CREATE TABLE` statements). This is the migration that `wrangler d1 migrations apply` would run. |
| `prisma/migrations-postgresql/` | `postgresql` | ❌ Not used | Future Postgres migration path. Lock says `postgresql`. The SQL is larger (1501 lines) — contains PG-specific types (`JSONB`, `TIMESTAMPTZ`, etc.). Not relevant to D1 deployment. |

### 7.4 Missing tables in D1 migration — CRITICAL

The SQLite migration `prisma/migrations/20260925000000_init/migration.sql` declares 58 `CREATE TABLE` statements. The schema declares 60 models. The two missing tables:

| Model | Schema location | Migration status | Code that uses it | Impact |
| --- | --- | --- | --- | --- |
| `RateLimit` | `schema.prisma:1335-1343` | ❌ Missing from migration | `src/lib/rate-limit.ts:81` `db.rateLimit.updateMany`, `:88` `.findUnique`, `:96` `.upsert` | Code has try/catch → silently falls back to in-memory. In Workers production, every isolate has its own in-memory store → **rate limiting is per-isolate, not global**. Attacker can bypass OTP_SEND (5/10min), OTP_VERIFY (5/min), PAYMENT (5/min), WITHDRAW (3/hour) limits by spreading requests across isolates. **Severity: CRITICAL.** |
| `IdempotencyKey` | `schema.prisma:1346-1354` | ❌ Missing from migration | `src/lib/auth.ts:463` `.findUnique`, `:472` `.upsert` | Code has try/catch → silently falls back to in-memory. Same per-isolate problem: idempotency keys deduplicate only within one isolate, not across. Concurrent retries across isolates can double-execute the wrapped function. **Severity: HIGH** (lower than RateLimit because idempotencyKey is only used for the `withIdempotency` wrapper, whose usage is limited — grep showed only the helper definition + 0 callers in `src/` outside `auth.ts`). |

**Verification:**
```bash
$ grep -c "CREATE TABLE" prisma/migrations/20260925000000_init/migration.sql
58
$ grep "CREATE TABLE.*RateLimit\|CREATE TABLE.*IdempotencyKey" prisma/migrations/20260925000000_init/migration.sql
(no output)
```

**Fix:** Add a new migration `prisma/migrations/<timestamp>_add_d1_rate_limit_idempotency/migration.sql` containing:

```sql
CREATE TABLE "RateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");
CREATE INDEX "RateLimit_key_expiresAt_idx" ON "RateLimit"("key", "expiresAt");

CREATE TABLE "IdempotencyKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "response" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "IdempotencyKey_key_key" ON "IdempotencyKey"("key");
CREATE INDEX "IdempotencyKey_key_expiresAt_idx" ON "IdempotencyKey"("key", "expiresAt");
```

Then run `bunx wrangler d1 migrations apply mekanix --local` for local validation (NOT `--remote` per task constraints).

### 7.5 Missing unique constraints (recommended additions)

| Model | Field(s) | Why needed | Code that would benefit |
| --- | --- | --- | --- |
| `UserVipSubscription` | `paymentId` | Prevents double-subscribe from same payment (currently enforced by non-atomic `findFirst` check at `vip/subscribe/route.ts:63`) | `vip/subscribe/route.ts:63-68` |
| `WalletTransaction` | `(jobId, kind)` | Prevents duplicate PREPAY/COMMISSION records from the same job (currently `prepay/route.ts:138, :153` create 2 rows per prepay; a retry of prepay after step 1 succeeded would create duplicates) | `prepay/route.ts` (note: `jobId` is nullable on WalletTransaction — would need a partial unique index or a separate `prepayPaid` check) |
| `Payment` | `code` | Already `@unique` (line 411) | PASS |
| `Invoice` | `jobId` | Already `@unique` (line 379) | PASS |
| `Warranty` | `jobId` | Already `@unique` (line 485) | PASS — but `payments/route.ts:128, :174` swallows the P2002 with `.catch(() => {})`, so duplicates can never occur anyway. |
| `Review` | `(jobId, fromUserId)` | Already `@@unique` (line 445) | PASS — but `reviews/route.ts` doesn't catch P2002, returns 500. |

### 7.6 Index gaps

| Model | Suggested index | Why |
| --- | --- | --- |
| `OtpCode` | `(phone, consumed, expiresAt)` | `otp/verify/route.ts:67-74` filters by all three. Existing index `(phone, createdAt)` (line 519) helps but doesn't cover the consumption check. |
| `Session` | `(userId, revokedAt, expiresAt)` | `auth.ts:214` filters by `userId, revokedAt: null` for `revokeAllUserSessions`. Existing index `(userId, expiresAt)` (line 92) doesn't cover `revokedAt`. |
| `WalletTransaction` | `(jobId, kind, status)` | `prepay/route.ts` and reconciliation queries filter by these. Existing `(jobId)` (line 728) is single-column. |
| `Notification` | `(userId, read, createdAt)` | Pagination by created-at after filtering by unread. Existing `(userId, read)` (line 478) doesn't cover the order-by field. |

---

## 8. Findings Table

| ID | File:Line | Severity | Description | Repro / Evidence | Status | Fix |
| --- | --- | --- | --- | --- | --- | --- |
| **D1-01** | `prisma/migrations/20260925000000_init/migration.sql` (missing) | **CRITICAL** | `RateLimit` and `IdempotencyKey` tables declared in `schema.prisma:1335, 1346` are NOT in the D1 migration SQL. Code in `rate-limit.ts:81,96` and `auth.ts:463,472` will throw "no such table" at runtime on D1. Both callsites are wrapped in try/catch with silent in-memory fallback — so production appears to work but rate limiting degrades to per-isolate (effectively bypassable across isolates). | `grep "CREATE TABLE.*RateLimit\|CREATE TABLE.*IdempotencyKey" prisma/migrations/20260925000000_init/migration.sql` returns nothing. Try/catch in `rate-limit.ts:106-109` and `auth.ts:485-494`. | **FAIL** | Add a new migration `<timestamp>_add_d1_rate_limit_idempotency/migration.sql` with the two CREATE TABLE statements (see §7.4). Apply via `wrangler d1 migrations apply` (NOT in this audit — that's the deploy step). |
| **D1-02** | `src/app/api/auth/otp/verify/route.ts:91-93` | **HIGH (performance)** | Full-table scan of `User` on every OTP verify, loaded into the Worker isolate, to support digits-only phone fallback matching. With >1000 users this will dominate Worker CPU time and likely cause 50ms+ p99 latency on every login. | `const allUsers = await db.user.findMany({ select: { id: true, phone: true } });` — no `take:` limit, no `where:` filter. | **FAIL** | Replace with `db.user.findUnique({ where: { phone } })` against the normalized phone (already `@unique`). For legacy users with non-normalized phones, run a one-time backfill migration that normalizes `User.phone` (strip non-digits, store canonical form). If the legacy lookup is still needed, add a `phoneDigits` column with an index and query it directly. |
| **D1-03** | `src/app/api/vip/subscribe/route.ts:63-68` + `prisma/schema.prisma:789-803` | **HIGH (race)** | Non-atomic read-then-write: `findFirst({ where: { paymentId, status: { in: [...] } } })` then `userVipSubscription.create({ data: { paymentId } })`. Two concurrent requests with the same `paymentId` can both pass the findFirst (no row exists yet) and both create a subscription — free-VIP bypass. | `UserVipSubscription` schema has no `@@unique([paymentId])`. `paymentId` is `String?` (nullable, line 798). | **FAIL** | Add `@@unique([paymentId])` to `UserVipSubscription` (SQLite treats NULLs as distinct, so nullable paymentId won't conflict). Catch P2002 in `vip/subscribe/route.ts:79` and return 409. |
| **D1-04** | `src/app/api/wallets/route.ts:65-77` | **HIGH (lost funds)** | SEC-8 fix correctly uses conditional `walletTransaction.updateMany` (count=1 wins race). But the followup `wallet.update({ pendingBalance: { decrement }, balance: { increment } })` is a separate write. If the second write fails (network blip, isolate eviction), the transaction row is AVAILABLE but the wallet balance was never credited. The technician's funds are lost from their view. | Code at line 70-76: separate `await db.wallet.update(...)` after the count===1 check. No retry, no compensation. | **FAIL** | Three options: (a) Make the wallet delta itself a conditional `updateMany({ where: { id, pendingBalance: { gte: t.netAmount } }, data: { ... } })` and check count — but this still doesn't atomically link the credit to the txn release. (b) Write to `walletLedger` first (atomic insert), then update wallet balance on read (compute `balance` as `SUM(netAmount) FROM WalletTransaction WHERE status='AVAILABLE'` — slow but always consistent). (c) Add a reconciliation cron that scans for AVAILABLE `WalletTransaction` rows where `releasedAt` is set but no matching `WalletLedger` row exists, and backfills the ledger + wallet update. Recommend (c) as the least invasive. |
| **D1-05** | `src/app/api/payments/route.ts:128, :174` | **MEDIUM (lost warranty)** | `warranty.create({ data: { jobId, ... } }).catch(() => {})` — silent failure means if `warranty.create` fails after `job.updateMany` (marking job COMPLETED), the customer silently loses the 6-month warranty entitlement. No log, no alert, no retry. | Lines 128 and 174: `.catch(() => {})` swallows all errors. | **FAIL** | Replace `.catch(() => {})` with `.catch(e => console.error("[payments] warranty.create failed for job:", inv.jobId, e))`. Schema `Warranty.jobId @unique` (line 485) means retry is safe — add a reconciliation check in `GET /api/jobs/[id]` (or a periodic cron) that creates a missing warranty for any COMPLETED job. |
| **D1-06** | `src/app/api/vip/subscribe/route.ts:71-74` → `:79-89` | **MEDIUM (state inconsistency)** | If `updateMany({ where: { userId, status: "ACTIVE" }, data: { status: "CANCELLED" } })` succeeds (cancels existing subscription) but `userVipSubscription.create` then fails, the user is left with NO active subscription. | Lines 71-74 (cancel) → 79-89 (create). No rollback on create failure. | **FAIL** | Wrap both writes in a single conditional transaction. Option: do `create` FIRST with `status: "ACTIVE"`, then `updateMany` to cancel others — but that temporarily leaves the user with two ACTIVE subscriptions. Better: change the schema so only one subscription per user can be ACTIVE via a partial unique index (SQLite doesn't support partial indexes, so use `@@unique([userId])` where status='ACTIVE' is enforced at app level via the updateMany). |
| **D1-07** | ~25 `findMany` calls without `take:` LIMIT | **MEDIUM (performance / DoS)** | Many list endpoints do unbounded `findMany`. Worst offenders: `dashboard/route.ts` (7 full-table scans per dashboard render); `auth/otp/verify/route.ts:91` (full User table per login); `support/tickets/route.ts:22` (all tickets, no pagination); `care/bookings/route.ts:133` (all bookings, no pagination); `service-requests/route.ts:147` (all technicians). | Grep `findMany\(\{` shows 30+ matches; `take:` is set in only 7 of them. | **FAIL** | Add `take: 50` (or similar) to all list endpoints. Add pagination (cursor-based for D1, since OFFSET is O(n)). For `dashboard/route.ts`, add `take: 1000` to the aggregate scans + index the `createdAt` field on `Payment`, `ServiceRequest`, `Job`. |
| **D1-08** | `src/app/api/support/tickets/route.ts:81-98` | **MEDIUM (N+1)** | For each admin found by `user.findMany({ where: { role: "ADMIN" } })`, a separate `notification.create` is run in a loop. With N admins, this is N inserts. | Lines 82-98: `for (const admin of admins) { await db.notification.create(...) }` | **FAIL** | Replace with `await db.notification.createMany({ data: admins.map(a => ({ userId: a.id, ... })) })`. D1 adapter supports `createMany` for plain inserts. |
| **D1-09** | `src/app/api/reviews/route.ts:74-84` | **MEDIUM (race + 500)** | Non-atomic `findFirst({ where: { jobId, fromUserId } })` then `review.create`. Schema `@@unique([jobId, fromUserId])` (line 445) will reject the second concurrent create with P2002, but the route does NOT catch it — returns a 500 instead of 409. | Lines 69-72 (findFirst check) → 74-84 (create). No P2002 handler. | **FAIL** | Wrap `review.create` in try/catch; on `Prisma.PrismaClientKnownRequestError` with `e.code === "P2002"`, return 409 Conflict. |
| **D1-10** | `src/app/api/jobs/[id]/status/route.ts:175-178` | **MEDIUM (stuck funds)** | When job transitions to COMPLETED, `walletTransaction.updateMany({ where: { jobId, status: "PENDING" }, data: { holdUntil } })` sets the 12h hold. If this fails (after the job is already COMPLETED), the walletTransactions stay PENDING with `holdUntil: null`. The auto-release filter at `wallets/route.ts:53` (`t.holdUntil && t.holdUntil.getTime() < now.getTime()`) skips null `holdUntil` — funds stuck forever. | Lines 175-178. No retry, no reconciliation. | **FAIL** | Either (a) change the auto-release filter to compute `holdUntil` from `createdAt` if null (`holdUntil ?? createdAt + 12h`), or (b) make step (2) idempotent + retryable on the next wallet GET. |
| **D1-11** | `src/app/api/care/bookings/[id]/approve-extra/route.ts:102-122` | **MEDIUM (state inconsistency)** | `customerApproval.update({ where: { id } })` (no status precondition) and `serviceBooking.update({ where: { id } })` (no status precondition) — both unconditional. If approval is marked CUSTOMER_APPROVED but the booking status update fails, the approval is approved but the booking is still WAITING_CUSTOMER_APPROVAL. | Lines 102-122. | **FAIL** | Convert to `customerApproval.updateMany({ where: { id, status: "PROPOSED" }, ... })` and `serviceBooking.updateMany({ where: { id, status: "WAITING_CUSTOMER_APPROVAL" }, ... })`. Check counts; if 0, return 409 without partial writes. |
| **D1-12** | `src/app/api/auth/otp/verify/route.ts:67-79` → `:113-126` | **LOW (OTP burned on user-create failure)** | The OTP is consumed (atomic `updateMany` count=1) BEFORE user lookup/create. If user creation fails (e.g. duplicate email constraint, DB error), the OTP is now invalid and the user must wait for a new one. Annoying UX, not a security issue. | Lines 67-79 consume; 113-126 create user + customer. | **PASS (with note)** | Reorder: validate user-existence FIRST (read-only `findUnique`), then atomically consume + create session. The current consume-first design was likely chosen to prevent OTP brute-force (consuming on each attempt limits retries to 5/min via rate limit). Acceptable trade-off. |
| **D1-13** | `prisma/schema.prisma:9-12` (generator) | **LOW (resilience)** | Generator has no `previewFeatures`. The D1 adapter works today only because `build-cloudflare.sh:92` injects `engineType = "client"` at build time. If a Prisma upgrade changes defaults, the adapter may not wire. | Schema line 9-12. | **PASS (today) / WARN (future)** | Add `previewFeatures = ["driverProviders"]` (or whatever the current Prisma 6.x equivalent is) to make the intent explicit and resilient to upgrades. |
| **D1-14** | `src/lib/db.worker.ts:47-53` (mock adapter) | **LOW (build-only)** | The build-time mock adapter (`{ provider: "sqlite", adapterName: "mock-build-adapter", connect: async () => ({ execute: async () => ({ rows: [] }) }), disconnect: async () => {} }`) is a minimal stub used only during OpenNext's page-data collection phase. It returns empty rows for any query. If a page's static-generation calls a real Prisma query at build time, it will get `[]` back — possibly producing a broken static page. | Lines 47-53. | **PASS** (acceptable; OpenNext page-data collection is meant to be no-op for this app, which is dynamic-rendered). | None needed. Note for future: if any page becomes `static: true`, the mock will produce empty data — flag in build logs. |
| **D1-15** | `src/app/api/care/bookings/route.ts:88-113` | **LOW (audit gap)** | `serviceBooking.create` then `pricingSnapshot.create` then `serviceBooking.update({ pricingSnapshotId })` — 3 sequential writes. If the link update fails, the booking has no `pricingSnapshotId` — affects audit trail. | Lines 88-113. | **PASS** (acceptable; non-financial) | Reorder: create `pricingSnapshot` first, then `serviceBooking.create({ pricingSnapshotId })` with the snapshot ID inline — single atomic link. |
| **D1-16** | `docs/d1-migration-inventory.json` | **INFO (stale doc)** | Inventory claims 7 unmigrated files including a phantom `src/lib/db-sequential.ts` that doesn't exist. Reality: all 76 consumers are migrated. | `grep -r "db-sequential" src/` returns nothing. | **PASS (code) / FAIL (doc)** | Either delete `docs/d1-migration-inventory.json` or update it to reflect the completed migration. (Not in this audit's scope — flag for Agent 9 / docs cleanup.) |
| **D1-17** | `src/lib/dispatch.ts:207` (`createMany`) | **LOW (unverified at runtime)** | `db.dispatchCandidate.createMany({ data: [...] })` — D1 adapter support for `createMany` is undocumented for v6.19.3. If unsupported at runtime, dispatch assignment will fail. | One callsite. | **BLOCKED (cannot verify without running against real D1)** | Test in local D1 (`wrangler d1 execute --local`) before relying on it. Fallback: `Promise.all(candidates.map(c => db.dispatchCandidate.create({ data: c })))` — slower but guaranteed compatible. |
| **D1-18** | `src/app/api/jobs/[id]/status/route.ts:287-307` | **LOW (stuck-in-WAITING_APPROVAL)** | If `invoice.create` fails after the job is already WAITING_APPROVAL, the customer has no invoice to pay. | Lines 287-307. Schema `Invoice.jobId @unique` means retry is safe. | **PASS** (acceptable; the `if (!job.invoice)` check at line 278 means a retry of the status transition would re-attempt invoice creation — but the state-machine validation `isAllowedTransition` would reject a same-status transition). | Add a reconciliation check on `GET /api/invoices?jobId=X` that auto-creates a missing invoice if `job.status === "WAITING_APPROVAL" && !job.invoice`. |

**Summary:**
- **CRITICAL: 1** (D1-01)
- **HIGH: 3** (D1-02, D1-03, D1-04)
- **MEDIUM: 7** (D1-05, D1-06, D1-07, D1-08, D1-09, D1-10, D1-11)
- **LOW: 5** (D1-12, D1-13, D1-14, D1-15, D1-18)
- **INFO: 1** (D1-16)
- **BLOCKED: 1** (D1-17)
- **PASS (today):** db access layer architecture, `$transaction`/`$queryRaw` usage, schema provider, per-request PrismaClient caching, build-time swap-and-restore trap.

---

## 9. Missing Test Cases (for Agent 6 — do NOT add in this pass)

The current test suite (`tests/unit/*.test.ts`, 15 files, 4865 LOC) tests route handlers with **mocked `getDbForLib`** (see `tests/unit/wallets-withdraw.test.ts:50-74`). **No test verifies D1-specific behavior.** Specific gaps:

### 9.1 D1 adapter integration tests (none exist)
- **MISSING:** Test that `getDbForLib()` returns a PrismaClient wired with `PrismaD1` adapter when `navigator.userAgent === "Cloudflare-Workers"`. (Mock `navigator.userAgent`, call `getDbForLib()`, assert `getDb` was called.)
- **MISSING:** Test that the per-request PrismaClient cache (`Symbol.for("mekanix.prismaClient")`) returns the same instance within one request and a new instance across requests. Mock `getCloudflareContext` to return different ctx objects.
- **MISSING:** Test that the throwing Proxy in `db.worker.ts:30-39` throws the documented error message when accessed in Workers runtime. (Currently no test verifies the Proxy.)

### 9.2 Migration correctness tests (none exist)
- **MISSING:** Test that the D1 migration SQL is idempotent (running it twice produces the same schema). Run via `wrangler d1 migrations apply --local` against a fresh local D1, snapshot the schema, re-apply, snapshot again, compare.
- **MISSING:** Test that `prisma/migrations/20260925000000_init/migration.sql` produces a schema that matches `prisma/schema.prisma` (i.e., every model in the schema has a corresponding CREATE TABLE in the migration). **This is the test that would have caught D1-01.** Run `bunx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` and assert empty diff.
- **MISSING:** Test that `wrangler d1 migrations list --local` shows migration `20260925000000_init` as applied and shows ZERO pending migrations.

### 9.3 Rate-limit / IdempotencyKey D1 tests (none exist — would catch D1-01)
- **MISSING:** Test that `rateLimitAsync()` actually persists to D1 (not just in-memory) when D1 is available. Mock `getDbForLib` to return a mock client whose `rateLimit.updateMany` returns count=1, assert that the in-memory fallback was NOT used.
- **MISSING:** Test that `rateLimitAsync()` correctly atomically increments (two concurrent calls with the same key, only one should get count=1, the other count=2 — currently neither test exists).
- **MISSING:** Test that `withIdempotency()` from `auth.ts` (lines 429-504) actually persists the response to D1 and returns cached on second call with same key.

### 9.4 Race / atomicity tests (partial coverage exists, gaps remain)
- **EXISTING:** `wallets-auto-release.test.ts` covers SEC-8 (count=1 wins, count=0 skips) — PASS.
- **EXISTING:** `wallets-withdraw.test.ts` covers B2.2 (decrement count=0 → no orphaned WithdrawalRequest) — PASS.
- **MISSING:** Test that `wallets/route.ts:65-77` is resilient to a failure between `walletTransaction.updateMany` (count=1) and `wallet.update` (the second write). Currently no test simulates a mid-flow failure. (This is the D1-04 lost-funds scenario.)
- **MISSING:** Test that `vip/subscribe/route.ts:63-89` rejects a duplicate `paymentId` (would catch D1-03). Currently no test exercises the duplicate-payment path.
- **MISSING:** Test that `payments/route.ts:128, :174` does NOT silently swallow warranty creation failure. (Currently the `.catch(() => {})` is invisible to tests.)
- **MISSING:** Test that `reviews/route.ts:74-84` returns 409 (not 500) on P2002 unique-violation from `@@unique([jobId, fromUserId])`.
- **MISSING:** Test that `care/bookings/[id]/approve-extra/route.ts:102-122` rejects a state-inconsistent transition (e.g., approval already CUSTOMER_APPROVED but booking still WAITING_CUSTOMER_APPROVAL).

### 9.5 Performance / pagination tests (none exist)
- **MISSING:** Test that `auth/otp/verify/route.ts:91-93` does NOT do a full-table scan (would catch D1-02). Mock `db.user.findMany`, assert it was NOT called, or assert it was called with `where: { phone: ... }` (not unbounded).
- **MISSING:** Test that all `findMany` calls in list endpoints have a `take:` limit. Static check via AST traversal or grep-based lint.

### 9.6 Workers-runtime smoke tests (none exist)
- **MISSING:** End-to-end smoke test in Miniflare / `wrangler dev --local` that:
  - Boots the Worker
  - Calls `GET /api/health` — expects 200 (verifies `PrismaD1` adapter + `$queryRaw\`SELECT 1\`` works on real D1)
  - Calls `GET /api/ready` — expects 200
  - Calls `POST /api/auth/otp/send` — expects the `RateLimit` table to be hit (would catch D1-01 in integration)
- **MISSING:** Test that `wrangler.toml`'s `DB` binding is correctly referenced by `db-worker.ts:45` (would catch a misconfigured binding name).

### 9.7 Schema/migration drift tests (none exist)
- **MISSING:** Pre-commit / CI check that runs `bunx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-migrations prisma/migrations --script` and fails if non-empty. This would have caught D1-01 at PR time.
- **MISSING:** Test that `prisma/migrations-postgresql/migration_lock.toml` says `postgresql` and `prisma/migrations/migration_lock.toml` says `sqlite` (currently both are correct, but no test enforces this).

---

## Appendix A: Stale inventory cross-reference

The stale `docs/d1-migration-inventory.json` (generated 2026-10-12) is **superseded** by this audit. The reality, as of audit time:

| Stale claim | Reality |
| --- | --- |
| `migrated_files: 70` | `76` files import `getDbForLib` (under-count by 6) |
| `remaining_files: 7` | `0` remaining — all consumers migrated |
| `remaining_db_calls: 26` | `0` remaining |
| `src/lib/db-sequential.ts` (P4-lib) | Does NOT exist (phantom) |
| `src/app/api/admin-panel/auth/login/route.ts` (remaining) | Line 37 calls `getDbForLib()` — migrated |
| `src/app/api/admin-panel/auth/me/route.ts` (remaining) | Line 8 calls `getDbForLib()` — migrated |
| `src/app/api/admin-panel/onboarding/route.ts` (remaining) | Lines 9, 18 call `getDbForLib()` — migrated |
| `src/app/api/admin-panel/onboarding/[id]/route.ts` (remaining) | Lines 41, 72 call `getDbForLib()` — migrated |
| `src/app/api/admin/[resource]/route.ts` (remaining) | Line 74 calls `getDbForLib()` — migrated |
| `src/app/api/admin/[resource]/[id]/route.ts` (remaining) | Line 85 calls `getDbForLib()` — migrated |
| `migrated_lib_files: 11` | `12` (adds `notifications.ts`) |

**Conclusion:** The migration described in the stale inventory has since been completed in full. The new gaps (D1-01: missing tables; D1-02: full-table scan in OTP verify; D1-03: VIP race; D1-04: lost-funds in wallet auto-release; D1-05: silent warranty loss) are regressions or post-migration issues that the stale inventory did not capture.

---

## Appendix B: Audit methodology

- All findings verified by direct `Read` of source files on the working tree at HEAD `23b71d2` (code-identical to `feature/cloudflare-d1-validation @ 1cf59e7`).
- All file:line references current as of audit time.
- No source files modified.
- No `prisma migrate` run against any remote DB.
- No `wrangler d1 execute` run.
- No `bun run db:generate` run (dev server on :3000 was preserved per task constraint).
- 29 modified tracked files (recovered UI assets) were NOT touched.
- `prisma migrate diff` was NOT run (would require running `prisma generate` first, which could disrupt the dev server); the migration-vs-schema drift was verified by grep on the migration SQL and by visual comparison of model declarations in the schema.
