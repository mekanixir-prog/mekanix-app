# Backend Security Audit v2 — `feature/cloudflare-d1-validation @ f0e00c5`

**Task ID:** SEC-AUDIT-2
**Agent:** Backend Security Auditor
**Scope:** VIP bypass, wallet race conditions, OTP reuse, BOLA/IDOR, auth/role/RL/validation
**Branch:** `feature/cloudflare-d1-validation`
**SHA:** `f0e00c5223cc53c3429a77c79376360dd5121b08`
**Prior context:** `tail -30 /home/z/my-project/worklog.md` (FINAL stage by Release Coordinator; baseline at f33a5be).

---

## 1. Executive Summary

Audit performed read-only against `f0e00c5`. Eight targeted test suites executed (107 tests); **all pass except the one deliberately-marked `it.fails()` documenting the known VIP-01 TOCTOU race**.

| # | Area | Status | Critical | High | Medium | Low |
|---|------|--------|----------|------|--------|-----|
| 1 | VIP bypass / paid features | PASS with 1 OPEN | 0 | 0 | 1 | 0 |
| 2 | Wallet double-counting | PASS | 0 | 0 | 0 | 0 |
| 3 | OTP reuse | PASS | 0 | 0 | 0 | 0 |
| 4 | Wallet withdraw race | PASS | 0 | 0 | 0 | 0 |
| 5 | BOLA / IDOR | PASS | 0 | 0 | 0 | 0 |
| 6 | Auth / roles / RL / validation / errors | PASS | 0 | 0 | 0 | 0 |
| **Total** | | | **0** | **0** | **1** | **0** |

**Release readiness verdict:** **READY (conditional)**.

- 0 code blockers on this audit's scope.
- 1 medium-severity known issue (VIP-01 TOCTOU) is **documented, gated by `it.fails()`**, and sequentially mitigated — a second sequential subscribe with the same `paymentId` returns 409. The residual risk is a true concurrent double-submit (race window < request round-trip), which requires both (a) the same `paymentId` being submitted twice in parallel and (b) no `@@unique(paymentId)` constraint enforcing it at the DB layer.
- All previously fixed items (SEC-7, SEC-8, SEC-9, SEC-10, SEC-11, SEC-21, SEC-22, B2.2) verified still in place at `f0e00c5`.
- Carry-over from prior audit: 5 owner-action items (set `ADMIN_JWT_SECRET`, `SMS_PROVIDER`, `PAYMENT_PROVIDER`, `DATABASE_URL` D1 binding, apply D1-01 migration remote-side). These are operational gating items, not code blockers.

---

## 2. Per-Item Findings

### Area 1 — VIP bypass / paid features without payment

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| VIP-A | Can a user get VIP without paying? | `src/app/api/vip/subscribe/route.ts:18-20, 49-60` | — | Production guard returns 404 in prod (L18-20). `paymentId` validated server-side: must exist (L52), belong to caller (`payment.userId !== userId` → 400, L55), status must be `SUCCEEDED` (L56), amount must cover `plan.priceIrr` (L57). Body userId is never read (L34: `userId = session.userId`). | PASS / VERIFIED | None needed (SEC-7 fix retained). |
| VIP-B | Does `/api/vip/my` verify subscription is active and paid? | `src/app/api/vip/my/route.ts:14-24` | — | Auto-expires `ACTIVE` subs with `expiresAt < now` (L15-18). Only queries `status: "ACTIVE"` (L21). `userId` derived from session (L10). | PASS / VERIFIED | None needed. |
| VIP-C | Is `paymentId` reuse prevented (VIP-01 fix)? | `src/app/api/vip/subscribe/route.ts:62-68` | Medium | Sequential reuse blocked: `findFirst({ paymentId, status: { in: ["ACTIVE","CANCELLED","EXPIRED"] } })` → 409 if found (L63-68). **TOCTOU race window:** two truly concurrent POSTs both pass `findFirst` (both see null) and both call `create`. Schema has **no `@@unique(paymentId)`** constraint (`prisma/schema.prisma:789-803`). | PASS (sequential) / OPEN (concurrent) | Add `@@unique([paymentId])` to `UserVipSubscription` schema OR use conditional `createMany` / Prisma `upsert` keyed on `paymentId`. Currently gated by `it.fails()` in `tests/unit/payment-wallet-audit.test.ts:684` (test passes today by failing). |
| VIP-D | Can VIP status be set manually via API? | `src/app/api/admin/[resource]/[id]/route.ts:8-19` | — | Admin resource whitelist (`RESOURCE_ALLOWED_FIELDS`) covers `customers`, `technicians`, `categories`, `reviews`, `payments` — **no `vipSubscriptions` entry**. Admin cannot mutate VIP via the generic admin route. No other admin route exposes VIP writes. | PASS / VERIFIED | None needed. |

**Tests run:** `tests/unit/vip-subscribe.test.ts` (11/11 PASS), `tests/unit/payment-wallet-audit.test.ts` VIP-01 block (1 control PASS + 1 sequential-control PASS + 1 `it.fails()` documenting race).

---

### Area 2 — Wallet double-counting in concurrent requests

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| WLT-A | Is balance increment/decrement atomic? | `src/app/api/wallets/route.ts:65-78` | — | **SEC-8 fix retained.** Auto-release uses conditional `walletTransaction.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "AVAILABLE", releasedAt: now } })`. Only when `releaseResult.count === 1` (race winner) does the route call `wallet.update({ data: { pendingBalance: { decrement }, balance: { increment } } })` (L69-76). Race loser sees `count === 0` and skips the wallet delta. | PASS / VERIFIED | None needed. |
| WLT-B | Race condition on concurrent withdraw? | `src/app/api/wallets/withdraw/route.ts:82-90` | — | **SEC-9 fix retained.** Atomic decrement via `wallet.updateMany({ where: { id: wallet.id, balance: { gte: amount } }, data: { balance: { decrement: amount } } })`. `count === 0` → throws "balance changed by concurrent request" (L89) → 400. Two concurrent withdraws cannot both succeed. | PASS / VERIFIED | None needed. |
| WLT-C | Read-modify-write patterns? | `src/app/api/wallets/route.ts:50-78` | — | No bare `findUnique`+`update` sequence on wallet balance. The pre-fix pattern (unconditional `update` + double-credit) was replaced by conditional `updateMany` with count check (L65-77). The withdraw route re-reads the wallet AFTER the atomic decrement (L95) for the ledger balance — but that's a display value, not a check-and-write. | PASS / VERIFIED | None needed. |

**Tests run:** `tests/unit/wallets-auto-release.test.ts` (5/5 PASS — winner credits, loser doesn't, multi-txn per-row, already-AVAILABLE skipped, future-hold skipped).

---

### Area 3 — OTP reuse

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| OTP-A | Is the OTP code one-time-use? | `src/app/api/auth/otp/verify/route.ts:66-79` | — | **SEC-10 fix retained.** Single conditional `otpCode.updateMany({ where: { phone, code: codeHash, consumed: false, expiresAt: { gt: now } }, data: { consumed: true } })`. `count === 1` → proceed to login; `count === 0` → 400 "Invalid or expired code". This single statement atomically transitions `consumed:false → true`. | PASS / VERIFIED | None needed. |
| OTP-B | Can the same code be used twice? | `src/app/api/auth/otp/verify/route.ts:67-75, 77-79` | — | Atomic `updateMany` with `consumed: false` in WHERE. Two concurrent verify requests with the same valid code: only one returns `count === 1` (winner); the other gets `count === 0` → 400. The legacy `findFirst + update` pattern is NOT used (test asserts `mockOtpFindFirst` not called, `mockOtpUpdate` not called). | PASS / VERIFIED | None needed. |
| OTP-C | Code is hashed (not plaintext) at rest? | `src/app/api/auth/otp/verify/route.ts:50, 70` | — | User-supplied code is SHA-256-hashed via `hashOtpCode(code)` BEFORE the WHERE lookup. DB stores only the hash. Read-only DB leak (SQLi, backup) cannot reveal usable codes. `src/lib/otp-crypto.ts:7-9` uses CSPRNG `crypto.randomInt(100000, 1000000)` for generation (NOT `Math.random`). | PASS / VERIFIED | None needed. |
| OTP-D | Rate limited? | `src/app/api/auth/otp/verify/route.ts:19-30` | — | `rateLimitAsync("otp-verify:${clientId}", 5, 60_000)` — 5 per minute per IP. Redis-backed via D1 `RateLimit` table when configured; in-memory fallback in dev. | PASS / VERIFIED | None needed. |

**Tests run:** `tests/integration/auth.test.ts` (13/13 PASS) — explicit assertions that `updateMany` WHERE includes `phone + codeHash + consumed:false + expiresAt>now`, DATA sets `consumed:true`, and legacy `findFirst`/`update` are NOT called.

---

### Area 4 — Race condition in wallet withdraw

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| WDW-A | Concurrent withdraw requests — atomic balance check? | `src/app/api/wallets/withdraw/route.ts:70-90` | — | **B2.2 + SEC-9 fixes retained.** Inside the try block: (1) re-check balance early-bail (L72-75), (2) **atomic decrement FIRST** via `wallet.updateMany({ where: { id, balance: { gte: amount } }, data: { balance: { decrement: amount } } })` (L82-85). `count === 0` → throw → 400. No `WithdrawalRequest` created (the orphaned-request bug from pre-B2.2 is closed). | PASS / VERIFIED | None needed. |
| WDW-B | Balance check is atomic or read-then-write? | `src/app/api/wallets/withdraw/route.ts:48, 72-75, 82-90` | — | The initial check at L48 is a non-authoritative early bail (returns 400 if `balance < amount` before doing any work). The authoritative check is the atomic `updateMany` at L82-85 which combines the check + write into a single SQL `UPDATE ... WHERE balance >= amount` statement. Read-then-write race is closed. | PASS / VERIFIED | None needed. |
| WDW-C | Ledger consistency under race? | `src/app/api/wallets/withdraw/route.ts:95-125` | — | After atomic decrement succeeds, the route re-reads the actual post-decrement balance (L95) and writes the ledger with that actual value (L114-125), NOT a pre-computed `balanceBefore - amount`. This means the ledger matches the DB even if another concurrent withdraw landed between the decrement and the ledger write. | PASS / VERIFIED | None needed. |
| WDW-D | Rate limited + role gated? | `src/app/api/wallets/withdraw/route.ts:11-28` | — | Role gate: only `TECHNICIAN` (L11-13). Rate limit: 3 per hour per client (L18-28) via `RATE_LIMITS.WITHDRAW`. | PASS / VERIFIED | None needed. |

**Tests run:** `tests/unit/wallets-withdraw.test.ts` (2/2 PASS — count=0 creates no WithdrawalRequest, count=1 creates with correct ledger `balanceAfter`).

---

### Area 5 — BOLA / IDOR

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| BOL-A | Can user A read user B's job? | `src/app/api/jobs/[id]/route.ts:17-29` | — | `requireAuth` (L18) + `requireJobParticipant(session, id)` (L22). `requireJobParticipant` (`src/lib/auth.ts:300-321`): CUSTOMER must own `job.request.customerId`; TECHNICIAN must be assigned (`job.technicianId`); ADMIN bypasses. Returns 403/404 before any data fetch. | PASS / VERIFIED | None needed. |
| BOL-B | Invoice ownership check? | `src/app/api/invoices/[id]/route.ts:19-27` | — | Loads invoice to get `jobId` (L19-23, returns 404 if not found), then `requireJobParticipant(session, inv.jobId)` (L26). PATCH whitelists fields per role (L37-84); customer cannot set `status=PAID` (L77-83). Server-authoritative amounts (comments L39-42). | PASS / VERIFIED | None needed. |
| BOL-C | Vehicle ownership check? | `src/app/api/vehicles/[id]/route.ts:10-46` | — | Both DELETE and PATCH call `requireVehicleOwner(session, id)` before any mutation. `requireVehicleOwner` (`src/lib/auth.ts:286-297`) compares `vehicle.customerId` to caller's customer ID. Mass-assignment protection via `sanitizeInput(body, ALLOWED_FIELDS.vehicle)` (L40) — `customerId` is never in the whitelist, so it cannot be overridden. | PASS / VERIFIED | None needed. |
| BOL-D | Care booking participant check? | `src/app/api/care/bookings/[id]/timeline/route.ts:8-19` | — | **SEC-11 fix retained.** `requireAuth` (L8) + `requireBookingParticipant(session, id)` (L15) called BEFORE `db.serviceTimelineEvent.findMany` (L18). `requireBookingParticipant` (`src/lib/care-auth.ts:18-54`): CUSTOMER must own `booking.userId`; TECHNICIAN must be assigned (`booking.technicianId`); ADMIN bypasses. Without this check, any authenticated user could enumerate booking IDs to read another tenant's timeline. | PASS / VERIFIED | None needed. |
| BOL-E | Technician phone PII removed? | `src/app/api/technicians/[id]/route.ts:7-17` and `src/app/api/technicians/route.ts:12-28` | — | **SEC-22 fix retained.** `PUBLIC_USER_FIELDS` (L7-17 in `[id]/route.ts`, L18-28 in `technicians/route.ts`) selects: `id, name, avatar, role, status, country, currency, language, createdAt`. **`phone` is NOT in the list** (comment L13-17 of `technicians/route.ts` explicitly notes the SEC-22 removal). PATCH route also enforces self-or-admin (L56-65) + strips `BLOCKED_FOR_SELF` fields (L80-90). | PASS / VERIFIED | None needed. |
| BOL-F | Other BOLA gates verified by `requireX` helpers? | `src/lib/auth.ts:286-371` | — | Additional helpers exist and are used elsewhere: `requireVehicleOwner`, `requireJobParticipant`, `requireNotificationOwner`, `requireWalletOwner`, `requireTicketOwner`, `requirePolicyOwner`. All return 403 when the caller doesn't own the resource; all return null (allow) only for ADMIN or true owners. | PASS / VERIFIED | None needed. |

**Tests run:** `tests/security/bola-idor.test.ts` (42/42 PASS), `tests/unit/timeline-bola.test.ts` (5/5 PASS — non-participant 403, participant 200, missing booking 404 no-info-leak, ADMIN bypass, unauthenticated 401), `tests/unit/security-audit-negative.test.ts` BOLA section (Customer A↛B invoice/job/vehicle, Technician A↛B job status, non-admin↛admin routes — 9 of the 16 negative tests).

---

### Area 6 — Auth, role permissions, input validation, rate limiting, error handling

| ID | Item | File:Line | Severity | Evidence | Status | Fix |
|----|------|-----------|----------|----------|--------|-----|
| AUTH-A | Admin routes require admin auth? | `src/app/api/admin/[resource]/route.ts:68-69`; `src/app/api/admin/[resource]/[id]/route.ts:50-53`; `src/app/api/admin-panel/auth/me/route.ts:6-7`; `src/app/api/admin-panel/onboarding/route.ts:7-8,15-16`; `src/app/api/admin-panel/onboarding/[id]/route.ts:38,69` | — | Every admin handler calls `getAdminFromRequest(req)` and returns 401 on null. No admin route handler lacks the gate. | PASS / VERIFIED | None needed. |
| AUTH-B | SEC-21 admin auth bypass closed? | `src/lib/admin-auth.ts:5-58, 82-103` | — | **SEC-21 fix retained.** (1) Secret separation: `getAdminSecret()` prefers `ADMIN_JWT_SECRET`, falls back to `JWT_SECRET` with prod warning (L31-58). (2) Payload-shape validation in `verifyAdminToken`: requires `adminId` non-empty string AND `role ∈ {ADMIN, SUPER_ADMIN}` via `ADMIN_ROLES` Set (L82-103). A user JWT (role `CUSTOMER`) is rejected even if the signing secret collides. | PASS / VERIFIED | None needed (3 regression tests PASS in `security-audit-negative.test.ts`). |
| AUTH-C | Rate limiting applied to sensitive routes? | `src/lib/api-helpers.ts:14`; `src/app/api/auth/otp/send/route.ts:38-44`; `src/app/api/auth/otp/verify/route.ts:19-30`; `src/app/api/payments/route.ts:35-47`; `src/app/api/wallets/withdraw/route.ts:18-28`; `src/app/api/admin-panel/auth/login/route.ts:32,47-50` | — | `requireAuth` enforces 60/min per client by default. OTP send: 5/10min per phone + 20/hour per IP. OTP verify: 5/min per IP. Payments: 5/min per client. Withdrawals: 3/hour per client. Admin login: 5/15min per IP (fail-open on infra failure — documented). `rateLimitAsync` uses D1 `RateLimit` table with **atomic conditional increment** (`src/lib/rate-limit.ts:81-84`); falls back to in-memory in dev. | PASS / VERIFIED | None needed. |
| AUTH-D | Zod schemas used for POST/PATCH bodies? | `src/lib/schemas/auth.ts:1-75`; `src/lib/api-helpers.ts:48-57` | — | `otpSendSchema`, `otpVerifySchema`, `sessionSchema`, `adminLoginSchema` defined and applied via `validateBody(req, schema)` in `otp/send`, `otp/verify`, `vehicles` (POST), `care/bookings` (POST). Other PATCH/POST routes use `sanitizeInput(body, ALLOWED_FIELDS.X)` + `FORBIDDEN_FIELDS` Set for mass-assignment protection (`src/lib/auth.ts:376-405`). Admin route adds enum validation: `VALID_USER_STATUSES`, `VALID_PAYMENT_STATUSES` (`src/app/api/admin/[resource]/[id]/route.ts:24-27, 66-76, 150-155`). | PASS / VERIFIED | None needed. |
| AUTH-E | Error messages leak internal info? | `src/lib/auth.ts:417-425`; `src/app/api/admin/[resource]/[id]/route.ts:33-47` | — | `apiError` returns generic Persian message `"خطایی در پردازش درخواست رخ داد"` in production, full message only in dev (L420). Routes return Persian human-readable errors (`"موجودی کافی نیست"`, `"کار یافت نشد"`, etc.). Stack traces never serialized. `console.error` calls log to server only (e.g. `[audit log error]`, `[vip/subscribe] Failed to create notification`) — not exposed to client. Admin route uses `safeAudit` wrapper so audit-log failure never blocks mutation. | PASS / VERIFIED | None needed. |
| AUTH-F | Mass-assignment protection? | `src/lib/auth.ts:376-405`; `src/app/api/admin/[resource]/[id]/route.ts:78-83, 88-94`; `src/app/api/technicians/[id]/route.ts:75-90` | — | `FORBIDDEN_FIELDS` Set blocks `role, status, verified, rating, reviewCount, balance, password, ...` (L388-394). `ALLOWED_FIELDS` per-resource whitelists (L376-385). `sanitizeInput` filters to whitelist only (L397-405). Admin route strips FORBIDDEN_FIELDS again as defense-in-depth (L79-83). Technician PATCH has additional `BLOCKED_FOR_SELF` list (`verified, rating, reviewCount, completedJobs, level, status`) that even admins cannot set via that route (L80-90). | PASS / VERIFIED | None needed. |
| AUTH-G | Session token storage / revocation? | `src/lib/auth.ts:69-220` | — | Raw JWT NEVER stored in DB — only SHA-256 `tokenHash` (L72-74, 108). `verifySession` is fail-closed in prod: DB error → reject (L170-177). `revokeSession` + `revokeAllUserSessions` use conditional `updateMany` with `revokedAt: null` filter (idempotent). Cookie is `httpOnly`, `secure` in prod, `sameSite: "lax"`, 30-day TTL (L156-162). JWT is never returned in body or headers (L163-171 comment). | PASS / VERIFIED | None needed. |
| AUTH-H | Production-only fail-closed gates? | `src/lib/auth.ts:33-43, 121-129, 170-177`; `src/lib/admin-auth.ts:50-58`; `src/app/api/vip/subscribe/route.ts:18-20`; `src/app/api/payments/route.ts:29-31` | — | `getSecret()` throws in prod if `JWT_SECRET` missing (L37). `getAdminSecret()` throws in prod if neither secret set (L51-54). `createSession` throws in prod if DB session row cannot persist (L121-129). `verifySession` rejects in prod on DB error (L170-177). VIP subscribe + Payments return 404 in prod (dev-only simulators). | PASS / VERIFIED | None needed. |

**Tests run:** `tests/unit/security-audit-negative.test.ts` (16/16 PASS, including the 3 SEC-21 regression tests at L452-527).

---

## 3. Open vs Fixed

### Fixed (verified at `f0e00c5`)

| Fix ID | Description | Verified by |
|--------|-------------|-------------|
| SEC-7 | VIP subscribe 3-layer (prod guard + session userId + paymentId validation) | `vip-subscribe.test.ts` 11/11 PASS + `payment-wallet-audit.test.ts` PAY-01 + BOLA tests |
| SEC-8 | Wallet double-credit race — conditional `updateMany` with count check | `wallets-auto-release.test.ts` 5/5 PASS |
| SEC-9 | Wallet withdraw atomic balance decrement | `wallets-withdraw.test.ts` 2/2 PASS + `payment-wallet-audit.test.ts` withdraw tests |
| SEC-10 | OTP one-time-use — single atomic `updateMany` | `integration/auth.test.ts` 13/13 PASS |
| SEC-11 | Care booking timeline BOLA — participant check before read | `timeline-bola.test.ts` 5/5 PASS |
| SEC-21 | Admin auth bypass — ADMIN_JWT_SECRET + payload-shape validation | `security-audit-negative.test.ts` 3 SEC-21 regression tests PASS |
| SEC-22 | Phone PII removal from public technician endpoints | Code review of `technicians/route.ts` + `technicians/[id]/route.ts` (`PUBLIC_USER_FIELDS` excludes phone) |
| B2.2 | WithdrawalRequest orphan-prevention — decrement before create | `wallets-withdraw.test.ts` count=0 case PASS |
| PAY-01 | Payment simulator production guard (404 in prod) | `payment-wallet-audit.test.ts` line 191 |
| CFG-01 | `/api/ready` production safety gates | (Out of scope this audit — covered by FINAL stage) |
| CI-01 | Cloudflare build workflow | (Out of scope this audit — covered by FINAL stage) |

### Still Open

| ID | Severity | Description | File:Line | Recommended fix | Acceptance criterion |
|----|----------|-------------|-----------|-----------------|------------------------|
| VIP-01 | **Medium** | TOCTOU race on `paymentId` reuse in `/api/vip/subscribe`. Two concurrent POSTs with the same valid `paymentId` both pass `findFirst` (race window) and both call `create`, producing two `UserVipSubscription` rows for one payment. No `@@unique(paymentId)` constraint in `prisma/schema.prisma:789-803`. | `src/app/api/vip/subscribe/route.ts:62-68` + `prisma/schema.prisma:798` | Add `@@unique([paymentId])` to `UserVipSubscription` model OR replace `findFirst`+`create` with a conditional `createMany`/`upsert` pattern that fails on duplicate. | The `it.fails()` test at `tests/unit/payment-wallet-audit.test.ts:684` flips to PASS (remove `.fails` marker). |

**Why Medium, not High:** Sequential reuse IS prevented (control test at L654 returns 409 on second sequential call). Only true concurrent double-submit (race window < single round-trip) bypasses the check. Triggering requires both (a) the same `paymentId` submitted twice in parallel AND (b) an attacker who can replay a captured payment confirmation within the race window. Real paymentId values are server-generated CUIDs not guessable by an attacker; the realistic vector is a buggy client double-click handler. Mitigation cost is low (schema constraint) and impact is bounded (extra subscription, not direct financial loss).

---

## 4. Release Readiness Verdict

**Verdict: READY — conditional on owner-action items.**

### Code blockers
**0** in this audit's scope (VIP-01 is medium severity, documented, gated by `it.fails()`, and sequentially mitigated).

### Test evidence (executed at `f0e00c5`)
- `tests/unit/security-audit-negative.test.ts` — 16/16 PASS (3 SEC-21 regression tests included)
- `tests/unit/vip-subscribe.test.ts` — 11/11 PASS
- `tests/unit/wallets-withdraw.test.ts` — 2/2 PASS
- `tests/unit/wallets-auto-release.test.ts` — 5/5 PASS
- `tests/unit/timeline-bola.test.ts` — 5/5 PASS
- `tests/security/bola-idor.test.ts` — 42/42 PASS
- `tests/unit/payment-wallet-audit.test.ts` — 14/14 PASS (1 `it.fails()` documents VIP-01)
- `tests/integration/auth.test.ts` — 13/13 PASS

**Total: 107 tests run, 106 PASS + 1 expected-fail (VIP-01 documented).**

### Owner-action items (carry-over from FINAL stage, not code blockers)
1. Set `ADMIN_JWT_SECRET` in Cloudflare Workers secret store (closes SEC-21 layer 1 fully).
2. Set `SMS_PROVIDER` (OTP delivery).
3. Set `PAYMENT_PROVIDER` (real gateway; VIP subscribe + Payments routes are dev-only simulators gated by `NODE_ENV === "production"` → 404).
4. Set `DATABASE_URL` to the D1 binding.
5. Apply D1-01 migration remote-side (additive `RateLimit` + `IdempotencyKey` tables).

### Recommended follow-ups (non-blocking)
- Add `@@unique([paymentId])` to `UserVipSubscription` schema (closes VIP-01).
- Add an explicit paymentId-reuse test case to `tests/unit/vip-subscribe.test.ts` (covers the sequential path that is currently only tested in `payment-wallet-audit.test.ts`).
- Consider applying `validateBody` (Zod) consistently to all PATCH/POST bodies (currently applied to OTP send/verify, vehicles, care/bookings; admin and technician PATCH routes use inline `typeof` + `sanitizeInput` instead).
- Implement the planned `/api/auth/ws-token` short-lived WebSocket token endpoint (TODO comment at `src/app/api/auth/otp/verify/route.ts:167-171`).

---

**Audit complete.** Source files were read-only; no source files modified, no commits pushed, no deployments performed.
