# Phase 3 Security Audit — Backend

**Generated:** 2026-10-13
**Branch:** feature/cloudflare-d1-validation @ 917b2b2
**Scope:** Code-level review (no runtime/Workers testing yet)
**Method:** Static analysis of actual code in src/
**Constraints:** main untouched (e4c2faf), PR #3 open, no remote D1 migration, no deploy

---

## Summary

This audit reviews authentication, authorization (BOLA/IDOR), payment/wallet
safety, multi-step write integrity, and admin action logging. Findings are
classified by severity with concrete evidence from the code.

**Total findings: 6** (1 HIGH, 3 MEDIUM, 2 LOW)

---

## Finding SEC-1 — Branch protection NOT enabled on `main` (HIGH)

**Source:** GitHub repository settings (confirmed by user, 2026-10-13)

**Evidence:** GitHub shows no branch protection on `main`; no required status
checks. Green CI does not block merge — a failing PR could still be merged.

**Risk:** Any collaborator (or compromised token) could push directly to `main`
or merge a PR without CI passing. This bypasses all the safety work done so far.

**Recommendation:** Before merging PR #3:
1. Enable branch protection on `main` (Settings → Branches → Add rule)
2. Require status checks to pass: `quality`, `Lint + TypeCheck + Test`, `Docker Build`, `PostgreSQL Migration`
3. Require pull request reviews before merge
4. Restrict direct pushes to `main`
5. Optionally require linear history (no merge commits)

---

## Finding SEC-2 — Duplicate payment records can be created (MEDIUM)

**File:** `src/app/api/payments/route.ts`

**Evidence:** The payment POST flow checks for existing payment AFTER
`payment.findUnique({ where: { invoiceId } })`. Two concurrent requests
could both see "no existing payment" and both call `payment.create`:

```
Request A: findUnique(invoice) → no payment → create payment
Request B: findUnique(invoice) → no payment → create payment  ← duplicate!
```

The `invoice.updateMany({ where: { status: { not: "PAID" } } })` ensures
only ONE request flips invoice → PAID. But BOTH payment records would be
created (a data integrity issue, even if the invoice isn't double-charged).

**Mitigating factors:**
- The check `if (inv.status === "PAID") return 409` catches sequential retries
- `payment.findUnique({ where: { invoiceId } })` has a unique constraint
- Prisma will reject the second create (unique constraint on invoiceId)

**Actual risk:** LOW — the unique constraint on `invoiceId` prevents duplicate
payment records at the DB level. But the code doesn't handle the
`P2002` unique constraint violation gracefully — it would 500 instead of
returning a clean 409.

**Recommendation:** Wrap `payment.create` in try/catch for P2002 → return 409
with `{ alreadyPaid: true }`. Or use `withIdempotency()` helper (see SEC-3).

---

## Finding SEC-3 — Idempotency helper exists but is UNUSED (MEDIUM)

**Files:**
- Helper: `src/lib/auth.ts` — `withIdempotency()` (lines 446-485), `getIdempotencyKey()` (line 440)
- Routes: `payments/route.ts`, `prepay/route.ts`, `wallets/withdraw/route.ts`

**Evidence:**
```
$ grep -rn "withIdempotency\|getIdempotencyKey" src/app/api/
(empty — no route uses these helpers)
```

The `withIdempotency()` helper was built (caches responses by Idempotency-Key
header in D1 `IdempotencyKey` table) but never wired into any payment route.

**Risk:** Payment endpoints rely solely on application-level status checks
(inv.status === "PAID") which work for sequential retries but are weaker
than true idempotency (which would return the SAME response for the same
Idempotency-Key, even across retries/gateway failures).

**Recommendation:** Wrap `payments/route.ts` POST, `prepay/route.ts` POST,
and `wallets/withdraw/route.ts` POST in `withIdempotency()`. This would:
1. Return identical responses for duplicate requests with same key
2. Protect against gateway retries (e.g., Zarinpal/IDPay callbacks)
3. Leverage the already-built D1 IdempotencyKey table

---

## Finding SEC-4 — admin/[resource]/[id] has NO audit logging (MEDIUM)

**File:** `src/app/api/admin/[resource]/[id]/route.ts`

**Evidence:**
```
$ grep -c "writeAuditLog" src/app/api/admin/[resource]/[id]/route.ts
0
```

The admin-panel/onboarding routes DO call `writeAuditLog` (5 times), but the
generic `admin/[resource]/[id]` route — which handles customer status changes
(ban/activate), technician profile edits, review status, payment refunds —
has **zero audit logging**.

**Risk:** If an admin bans a user, changes a technician's verified status,
or marks a payment as REFUNDED, there's no audit trail. No way to answer
"who did this and when?" in case of a dispute or investigation.

**Recommendation:** Add `writeAuditLog()` calls to each branch of the
PATCH handler:
- technicians update → `UPDATE_TECHNICIAN`
- customers update (+ status change) → `UPDATE_CUSTOMER` + `CHANGE_USER_STATUS`
- categories update → `UPDATE_CATEGORY`
- reviews update → `UPDATE_REVIEW`
- payments update → `UPDATE_PAYMENT`

---

## Finding SEC-5 — Failed admin login attempts not tracked (LOW)

**File:** `src/app/api/admin-panel/auth/login/route.ts`

**Evidence:** The login route returns 404 (user not found) or 401 (wrong
password) but doesn't log the failed attempt. No rate limit on login
attempts (only the default API rate limit of 60/min applies).

**Risk:** Brute-force attacks on admin credentials have no detection or
throttling beyond the generic API rate limit.

**Recommendation:**
1. Add a stricter rate limit on `/api/admin-panel/auth/login` (e.g., 5/min)
2. Log failed attempts to `auditLog` (action: `FAILED_ADMIN_LOGIN`)
3. Consider account lockout after N failures (with admin notification)

---

## Finding SEC-6 — `auth/session` route exposes user data without BOLA check (LOW)

**File:** `src/app/api/auth/session/route.ts`

**Evidence:** The route uses `getSessionFromRequest` (verifies the JWT) but
then fetches the FULL user record by `session.userId`. The `SAFE_USER_SELECT`
excludes `password`, but it includes potentially sensitive fields (email,
phone, role, status).

**Assessment:** LOW risk — the data is the caller's OWN record (session.userId
is server-authoritative from JWT). No BOLA issue (user can only fetch their
own session data). But the response includes all fields in `SAFE_USER_SELECT`
unconditionally — if new sensitive fields are added to User model later,
they'd be exposed unless the select is updated.

**Recommendation:** Document that `SAFE_USER_SELECT` is the allowlist for
user-facing responses. Add a comment that any new sensitive field must NOT
be added to this select.

---

## Positive Findings (things done right)

### Authentication & Session
- ✅ `verifySession()` is fail-closed in production (DB error → reject)
- ✅ `createSession()` is fail-closed in production (DB error → throw)
- ✅ `revokeSession()` / `revokeAllUserSessions()` throw on DB error (no swallow)
- ✅ JWT secret required in production (no hardcoded fallback)
- ✅ Session DB records support revocation tracking

### Authorization (BOLA)
- ✅ 7 BOLA helpers: requireVehicleOwner, requireJobParticipant,
  requireNotificationOwner, requireWalletOwner, requireTicketOwner,
  requirePolicyOwner, requireAuth
- ✅ 41 usages across routes (good coverage)
- ✅ Zero write routes with auth but no BOLA helper (except admin-only)
- ✅ Admin routes use `requireRole(session, "ADMIN")` consistently

### Payment & Wallet
- ✅ `payments`: optimistic concurrency on invoice.status (updateMany)
- ✅ `wallets/withdraw`: atomic balance deduction (updateMany with balance gte)
- ✅ `prepay`: optimistic concurrency on prepayPaid
- ✅ Amounts are server-authoritative (from invoice/technician profile, not client)
- ✅ Production guards on prepay + gateway (404 in production)

### Public Routes (intentional)
All 11 no-auth routes verified as intentional public endpoints:
- `admin-panel/auth/login` — login (no auth needed)
- `auth/demo` — 404 in production
- `auth/otp/send` — OTP send (pre-auth)
- `auth/session` — returns own session data
- `care/packages`, `categories`, `vip/plans` — public catalogs
- `exchange-rate`, `health`, `ready`, `onboarding` — public status/content

### Mass Assignment Protection
- ✅ `sanitizeInput()` with `ALLOWED_FIELDS` whitelists on all POST/PATCH
- ✅ `FORBIDDEN_FIELDS` strips server-authoritative fields (role, balance, etc.)
- ✅ S1 fix: onboarding/[id] PATCH now validates types + enum
- ✅ S3 fix: customer status validated against UserStatus enum

### Multi-Step Writes (D1 has no $transaction)
All examined, all correct:
- ✅ Best-effort notifications (try/catch) — don't fail primary operation
- ✅ Idempotent guards on re-approve (mechanic-applications)
- ✅ Documented mid-failure trade-offs (reviews rating recompute)
- ✅ Security-critical ordering (user.status before customer.update)

---

## Recommended Next Steps (Phase 3 fixes)

### Priority 1 (before merge):
1. **SEC-1:** Enable branch protection on `main` (GitHub settings, no code)
2. **SEC-4:** Add audit logging to `admin/[resource]/[id]` PATCH handler

### Priority 2 (can be post-merge):
3. **SEC-3:** Wire `withIdempotency()` into payment/prepay/withdraw routes
4. **SEC-2:** Handle P2002 unique constraint on payment.create → 409

### Priority 3 (hardening):
5. **SEC-5:** Add login rate limit + failed login logging for admin
6. **SEC-6:** Document SAFE_USER_SELECT as allowlist

---

## Test Coverage Gaps

- No negative tests for BOLA (e.g., "customer A cannot read customer B's vehicle")
- No concurrent payment test (two simultaneous POST /api/payments)
- No audit log verification test
- No idempotency test (Idempotency-Key header behavior)

**Recommendation:** Add targeted negative tests for each finding before merge.

---

## Constraints Status

| Constraint | Status |
|-----------|--------|
| main untouched | ✅ e4c2faf |
| PR #3 open | ✅ not merged |
| no remote D1 migration | ✅ none executed |
| no deploy | ✅ none performed |
| all work on feature branch | ✅ 917b2b2 |
