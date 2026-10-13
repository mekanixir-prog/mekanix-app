# Phase 1 Audit — D1 Migration & Security Review

**Generated:** 2026-10-13
**Branch:** feature/cloudflare-d1-validation @ 98107eb
**Constraints:** main untouched (e4c2faf), PR #3 open, no remote D1 migration, no deploy

---

## 1. D1 Migration Inventory (from actual code scan)

### Migrated: 70 files (getDbForLib)
- 11 lib files: auth, rate-limit, service-write, service-unified, notifications, pricing, care-auth, vip, admin-auth, admin-api, dispatch
- 59 route files (all priority 1-3 routes + health/ready $queryRaw fix)

### Remaining: 7 files, 26 db calls

| # | File | Calls | Notes |
|---|------|-------|-------|
| 1 | `src/lib/db-sequential.ts` | 1 | **DEAD CODE** — `runSequential` is defined but never called anywhere. Only an unused import in jobs/[id]/status/route.ts. |
| 2 | `src/app/api/admin-panel/auth/login/route.ts` | 2 | adminUser.findFirst + update(lastLoginAt) |
| 3 | `src/app/api/admin-panel/auth/me/route.ts` | 1 | adminUser.findUnique |
| 4 | `src/app/api/admin-panel/onboarding/route.ts` | 3 | findMany + findFirst(order) + create + writeAuditLog |
| 5 | `src/app/api/admin-panel/onboarding/[id]/route.ts` | 5 | findUnique + update + delete + writeAuditLog (×3) |
| 6 | `src/app/api/admin/[resource]/route.ts` | 7 | Dynamic HANDLERS map (customers/technicians/jobs/payments/reviews/vehicles/categories/applications) |
| 7 | `src/app/api/admin/[resource]/[id]/route.ts` | 7 | Dynamic PATCH (technicians/customers/categories/reviews/payments) |

---

## 2. Security Findings

### Finding S1 — admin-panel/onboarding/[id] PATCH: mass-assignment (MEDIUM)
**File:** `src/app/api/admin-panel/onboarding/[id]/route.ts:29`
```ts
const updated = await db.onboardingSlide.update({ where: { id }, data: rest });
```
`rest` is the entire request body (minus imageBase64) passed directly to `update`. No `sanitizeInput` whitelist. A client could overwrite fields like `id`, `createdAt`, or any column on OnboardingSlide.
**Fix:** Add `sanitizeInput(body, ALLOWED_FIELDS.onboarding)` whitelist.

### Finding S2 — admin-panel/onboarding/[id] GET: no auth check (LOW)
**File:** `src/app/api/admin-panel/onboarding/[id]/route.ts:18-23`
The GET handler has no `getAdminFromRequest` call, unlike POST/PATCH/DELETE in the same file. This means any caller can read a slide by ID.
**Assessment:** Onboarding slides are likely intended to be public (shown to users in the app), so this may be by design. But it's inconsistent with the admin-panel pattern. **Recommend:** confirm intent; if public, move to a public route; if admin-only, add auth.

### Finding S3 — admin/[resource]/[id] customer status: no validation (MEDIUM)
**File:** `src/app/api/admin/[resource]/[id]/route.ts:61`
```ts
await db.user.update({ where: { id: customer.userId }, data: { status: body.status as any } });
```
`body.status` is cast to `any` with no validation. A client could set `status` to an arbitrary string. If the User model has an enum on status, Prisma will reject invalid values — but if it's a free-text column, this is exploitable.
**Fix:** Validate `body.status` against an allowed set (e.g. `["ACTIVE", "BANNED", "SUSPENDED"]`).

### Finding S4 — admin-auth.ts: 5 dead `getDbForLib()` calls (LOW, cleanup)
**File:** `src/lib/admin-auth.ts:29,34,39,48,62`
Five functions (`hashPassword`, `verifyPassword`, `createAdminToken`, `verifyAdminToken`, `getAdminFromRequest`) each call `const db = await getDbForLib()` but never use `db`. These are leftover from the migration. They create an unnecessary PrismaClient on every call (performance cost, no security impact).
**Fix:** Remove the unused `const db = await getDbForLib()` lines.

### Finding S5 — db-sequential.ts: dead code (LOW, cleanup)
**File:** `src/lib/db-sequential.ts` + `src/app/api/jobs/[id]/status/route.ts:5`
`runSequential` is defined in db-sequential.ts and imported in jobs/[id]/status/route.ts, but **never called** anywhere. The route uses `db.job.updateMany` with optimistic concurrency instead.
**Fix:** Remove the unused import from jobs/[id]/status/route.ts. Either migrate db-sequential.ts to getDbForLib (for future use) or delete it.

---

## 3. Multi-Step Write Operations (mid-failure behavior)

These routes perform sequential writes without `$transaction` (D1 doesn't support it). Mid-failure behavior has been examined during P3 migration:

| Route | Steps | Mid-failure handling |
|-------|-------|---------------------|
| insurance/claim | create claim → update policy → notify | policy update + notify now best-effort (try/catch) |
| mechanic-applications/approve | find app → create/update user → create technician → update app → notify | idempotent (findUnique guards); notify best-effort |
| referral/claim | update referral → notify | notify best-effort |
| reviews | create review → recompute tech rating → update tech | documented trade-off: if tech.update fails, rating stale but self-corrects on next review |
| support/tickets | create ticket → notify admins (loop) → notify user | all notifications best-effort (per-iteration try/catch) |
| messages | create msg → find job → notify other party | notify best-effort |
| vip/subscribe | cancel existing → create new → notify | notify best-effort |

**Assessment:** All multi-step writes are handled correctly. No silent data corruption paths found.

---

## 4. Duplicate/Concurrent Request Risks

### Already protected (optimistic concurrency):
- **payments:** `updateMany({ where: { status: { not: "PAID" } } })` — duplicate payment guard (409)
- **wallets/withdraw:** `updateMany({ where: { balance: { gte: amount } } })` — atomic balance deduction
- **prepay:** optimistic concurrency on `prepayPaid`
- **jobs/[id]/status:** `updateMany({ where: { id, status: existing.status } })` — race-safe state machine
- **reviews:** duplicate guard (findFirst → 409 if already reviewed)
- **mechanic-applications:** duplicate technician guard (409)

### Needs review:
- **admin-panel/onboarding POST:** `findFirst(orderBy desc) + 1` to compute new order — two concurrent POSTs could get the same order number. Low impact (display only, not a key).
- **vip/subscribe:** cancel-existing + create-new is not atomic — two concurrent subscribes could create two active subscriptions. Low probability (same user double-clicking).

---

## 5. Test Coverage

### Current: 359 tests across 13 files
- `tests/e2e/business-flow.test.ts` — 47 tests (business flow scenarios)
- `tests/e2e/failure-scenarios.test.ts` — 28 tests (error handling)
- `tests/integration/auth.test.ts` — 13 tests (OTP + session)
- `tests/integration/care.test.ts` — 12 tests (CARE bookings)
- `tests/security/bola-idor.test.ts` — 42 tests (BOLA/IDOR protection)
- `tests/unit/care-auth.test.ts` — 45 tests (CARE auth transitions)
- `tests/unit/dispatch.test.ts` — 17 tests (dispatch logic)
- `tests/unit/lite-response.test.ts` — 17 tests (lite response compression)
- `tests/unit/offline-queue.test.ts` — 20 tests (offline queue)
- `tests/unit/permissions.test.ts` — 20 tests (role permissions)
- `tests/unit/pricing.test.ts` — 20 tests (pricing engine)
- `tests/unit/service-unified.test.ts` — 28 tests (service queries)
- `tests/unit/session-lifecycle.test.ts` — 26 tests (session revocation)

### Gaps:
- No dedicated tests for: vehicles, technicians, service-requests, jobs, dashboard, gateway, prepay, invoices, payments, wallets, insurance, mechanic-applications, maintenance, referral, reviews, support, vip, messages, notifications, exchange-rate, onboarding, health, ready, admin, admin-panel
- These routes ARE exercised indirectly via e2e + security tests, but not in isolation.
- **Recommend (Phase 2):** add targeted tests for the security findings above (mass-assignment, status validation).

---

## 6. Recommended Phase 2 Work Order

### Batch 1 — Cleanup + admin-panel migration (LOW risk)
1. Fix S4: remove 5 dead `getDbForLib()` calls from admin-auth.ts
2. Fix S5: remove unused `runSequential` import from jobs/[id]/status/route.ts; migrate or delete db-sequential.ts
3. Migrate admin-panel/auth/login + me + onboarding (4 files, 11 calls) to getDbForLib
4. Fix S1: add sanitizeInput to admin-panel/onboarding/[id] PATCH
5. Fix S2: confirm onboarding GET auth intent

### Batch 2 — admin/[resource] migration (MEDIUM risk)
1. Migrate admin/[resource]/route.ts (7 calls) to getDbForLib
2. Migrate admin/[resource]/[id]/route.ts (7 calls) to getDbForLib
3. Fix S3: validate customer status against allowed enum

### After both batches:
- Regenerate inventory (expect 0 remaining files, 0 remaining calls)
- Run full test suite
- Update PR #3 description

---

## 7. Constraints Status

| Constraint | Status |
|-----------|--------|
| main untouched | ✅ local main == remote main == e4c2faf |
| PR #3 open | ✅ not merged |
| no remote D1 migration | ✅ none executed |
| no deploy | ✅ none performed |
| all work on feature branch | ✅ feature/cloudflare-d1-validation @ 98107eb |
