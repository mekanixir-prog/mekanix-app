# AUDIT — Payment & Wallet Integrity (Agent B-5)

**Task ID:** B-5
**Agent:** Payment & Wallet Auditor
**Branch / HEAD:** `feature/cloudflare-d1-validation` @ `1cf59e7` (working tree on `main` @ `23b71d2` — code-identical per A-baseline)
**Scope:** Payment / Wallet / VIP / Gateway idempotency, race conditions, simulator-vs-real separation, ledger consistency, callback authenticity.
**Constraints honored:** READ-ONLY on all source EXCEPT one new test file (`tests/unit/payment-wallet-audit.test.ts`). No real payment, no real gateway call, no real wallet mutation. 29 user-modified files untouched.

---

## 1. Executive Summary

The payment/wallet subsystem is **safe to ship as a SIMULATOR-ONLY preview** — every payment-moving route (`/api/payments`, `/api/gateway/initiate`, `/api/gateway/verify`, `/api/prepay`, `/api/vip/subscribe`) returns `404` in `NODE_ENV === "production"` (PAY-01 pattern). The deployed `wrangler.toml` sets `NODE_ENV = "production"`, so in the live Cloudflare Worker **no payment route is reachable**. No real money can move.

Within the dev/preview mode that IS reachable, the prior fixes are present and correct:
- **PAY-01** (payments production guard) ✓
- **VIP-01** (VIP subscribe payment-reuse check) ✓ — but **non-atomic (TOCTOU)**; two concurrent subscribes with the same `paymentId` can both pass the `findFirst` check and both create ACTIVE subscriptions. The schema has no `@@unique` constraint on `UserVipSubscription.paymentId` to backstop the application-level check.
- **GW-02** (gateway verify atomic `updateMany`) ✓ — atomic, correct, closes the double-verify race.
- **GW-01** (gateway initiate amount max validation) ✓ — caps `amount` at 100M IRR (~$200 USD).

Two pre-existing atomic guards are correct and verified by tests:
- **B2.2 / SEC-9** withdraw: `wallet.updateMany WHERE balance >= amount` (atomic decrement before `withdrawalRequest.create`) ✓
- **SEC-8** wallet auto-release: `walletTransaction.updateMany WHERE status = PENDING` with count check ✓

One **dead-code** finding: `src/lib/payment-provider.ts` (the pluggable Zarinpal/IDPay/NextPay/simulator abstraction that reads `PAYMENT_PROVIDER` env var) is **NOT imported by any route handler**. Only e2e tests and docs reference it. The `PAYMENT_PROVIDER = "simulator"` line in `wrangler.toml` is currently a no-op. All simulator-vs-real separation is achieved through `NODE_ENV`-based 404 guards hardcoded into each route — not through `PAYMENT_PROVIDER` switching.

**Critical blockers for release: 0.** (Simulator-only mode is safe; the production guard blocks all money movement.)

**High-severity findings to address before wiring real payments: 3.**
- **PAY-05 (HIGH):** `/api/vip/subscribe` VIP-01 TOCTOU race — two concurrent subscribes with same `paymentId` can both create ACTIVE subscriptions. Backstop with `@@unique` on `UserVipSubscription.paymentId` or convert to conditional `updateMany`.
- **PAY-06 (HIGH):** No callback signature verification in `/api/gateway/verify` — accepts any `otp` of length ≥ 4. Acceptable for simulator (route is 404 in prod) but MUST be added before any real gateway integration. Documented as a future-work gate.
- **PAY-07 (HIGH):** Payment-system security depends on a single `NODE_ENV === "production"` string match per route. If `NODE_ENV` is unset or set to anything else in `wrangler.toml`, ALL payment routes become reachable in production → simulator paths run with real customers. Defense-in-depth: also require `PAYMENT_PROVIDER === "simulator"` AND verify `process.env.CF_PAGES` or similar.

**Medium / Low findings: 5** (PAY-02, PAY-03, PAY-04, PAY-08, PAY-09) — see findings table.

**Tests added:** `tests/unit/payment-wallet-audit.test.ts` — 14 tests, **13 PASS + 1 expected-fail** (`it.fails()` documenting the VIP-01 TOCTOU). Full suite: 403 passing (was 389), 1 expected fail, 0 regressions.

---

## 2. Simulator / Real Separation Analysis

### 2.1 Switch logic (where `PAYMENT_PROVIDER` is read)

| File:Line | Code | Effect |
|---|---|---|
| `wrangler.toml:18` | `PAYMENT_PROVIDER = "simulator"` | Sets env var in Worker runtime. |
| `wrangler.toml:19` | `NODE_ENV = "production"` | Sets env var in Worker runtime. |
| `src/lib/payment-provider.ts:182` | `const provider = process.env.PAYMENT_PROVIDER?.toLowerCase().trim();` | **Reads** `PAYMENT_PROVIDER` — but only inside `initPaymentProvider()`, which is only called by `createPayment()` / `verifyPayment()`. |
| `src/lib/payment-provider.ts:206-214` | `export async function createPayment / verifyPayment` | Public API of the abstraction. |

### 2.2 DEAD CODE finding — `payment-provider.ts` is NOT wired in

Grep across `src/` for `from "@/lib/payment-provider"`:

```
$ rg 'from ["'']@/lib/payment-provider["'']' src/
(no matches)
```

The only references are:
- `tests/e2e/business-flow.test.ts:36, 706, 718` — test imports.
- `tests/e2e/failure-scenarios.test.ts:26, 236, 248` — test imports.
- `docs/PRODUCTION_READINESS.md:74, 97` — documentation.
- `src/lib/payment-provider.ts:11` — comment example.

**Implication:** `PAYMENT_PROVIDER` env var currently has **zero effect** on the running application. Every payment route implements its OWN inline simulator logic (`Math.random()` in payments, hardcoded OTP acceptance in verify, etc.) and is gated by `NODE_ENV === "production"` → 404. The `payment-provider.ts` abstraction is scaffolding for a future migration that has not happened (confirmed in `worklog.md:5041`: "Existing `/api/gateway/initiate` + `/api/gateway/verify` routes were NOT modified … The new payment-provider.ts is ready to wire in once the existing simulator flow is migrated").

### 2.3 Production guard (PAY-01 pattern)

Every payment-moving route starts with:

```ts
if (process.env.NODE_ENV === "production") {
  return new NextResponse(null, { status: 404 });
}
```

| Route | File:Line | Guard present? |
|---|---|---|
| POST `/api/payments` | `src/app/api/payments/route.ts:29-31` | ✓ (PAY-01) |
| POST `/api/gateway/initiate` | `src/app/api/gateway/initiate/route.ts:11-13` | ✓ |
| POST `/api/gateway/verify` | `src/app/api/gateway/verify/route.ts:22-24` | ✓ |
| POST `/api/prepay` | `src/app/api/prepay/route.ts:36-38` | ✓ |
| POST `/api/vip/subscribe` | `src/app/api/vip/subscribe/route.ts:18-20` | ✓ (SEC-7) |
| GET `/api/wallets` | — | ✗ (no guard; intentional — wallet reads are safe, no money movement) |
| POST `/api/wallets/withdraw` | — | ✗ (no guard; intentional — withdraw is a real ledger op, not a gateway simulation) |
| GET `/api/vip/plans` | — | ✗ (no guard; intentional — public catalog read) |
| GET `/api/vip/my` | — | ✗ (no guard; intentional — read-only subscription lookup) |
| GET/POST `/api/invoices` | — | ✗ (no guard; intentional — invoice CRUD, no money movement) |

### 2.4 Risk of accidental real-mode activation

**Risk vector:** If `NODE_ENV` in `wrangler.toml` is unset, set to `"development"`, or set to any value other than the literal string `"production"`, ALL five payment routes become reachable in the Worker. The simulator logic then runs with real customer traffic:
- `/api/payments`: `Math.random() > 0.05` decides payment success.
- `/api/gateway/verify`: any 4+ char OTP is accepted.
- `/api/prepay`: any non-empty cardNumber succeeds.
- `/api/vip/subscribe`: any paymentId pointing to a SUCCEEDED payment grants VIP.
- `/api/gateway/initiate`: any amount ≤ 100M IRR is logged.

**Mitigation (recommended):**
1. **Defense-in-depth** — invert each guard to also require `PAYMENT_PROVIDER === "simulator"`:
   ```ts
   if (process.env.NODE_ENV === "production" || process.env.PAYMENT_PROVIDER !== "simulator") {
     return new NextResponse(null, { status: 404 });
   }
   ```
   Wait — this would BLOCK real-mode. The correct inversion is: **only allow simulator routes when `NODE_ENV !== "production"` AND `PAYMENT_PROVIDER === "simulator"`**. Once a real provider is wired in, the guard becomes `PAYMENT_PROVIDER !== "simulator" && <real provider configured>`. For now, the simplest safe addition is: also check `PAYMENT_PROVIDER !== "simulator"` as a SECOND 404 trigger (treat real-mode as opt-in only).
2. **CI check** — add a `wrangler.toml` validator that fails CI if `NODE_ENV` is not `"production"` in the production wrangler config.
3. **Runtime canary** — `/api/health` should expose `payment_mode` (currently it does NOT — it only exposes `sms` provider). Add `payment: process.env.PAYMENT_PROVIDER ?? "simulator"` to the health payload so monitoring can alert if it deviates.

### 2.5 Simulator path isolation

The simulator logic is **clearly isolated** from any real gateway API call:
- No `fetch()` calls to `zarinpal.com`, `idpay.ir`, or `nextpay` from any route handler. The only `fetch()` calls to those hosts are inside `payment-provider.ts` (which is dead code, see §2.2).
- The simulator paths are inline in each route — `Math.random()`, hardcoded OTP acceptance, etc. There is NO code path from a route handler to a real gateway API.
- The simulator paths are gated by `NODE_ENV === "production"` → 404.

**Conclusion:** The simulator path cannot accidentally invoke a real gateway. The risk is the inverse — that the simulator path runs in production (see §2.4).

---

## 3. Verified Prior Fixes

| ID | Description | File:Line | Present? | Correct? | Notes |
|---|---|---|---|---|---|
| **PAY-01** | `/api/payments` returns 404 in production | `src/app/api/payments/route.ts:29-31` | ✓ | ✓ | Guard runs BEFORE `requireAuth` — no DB calls occur in prod. Verified by `payment-wallet-audit.test.ts` test #1. |
| **VIP-01** | `/api/vip/subscribe` rejects already-used `paymentId` with 409 | `src/app/api/vip/subscribe/route.ts:62-68` | ✓ | ⚠️ Partial | The check is non-atomic: `findFirst` + check + `create` is a TOCTOU window. Two concurrent subscribes with the same `paymentId` can both pass. Schema (`UserVipSubscription.paymentId`) has NO `@@unique` constraint. **Demonstrated by `it.fails()` test #14.** |
| **GW-02** | `/api/gateway/verify` uses atomic `updateMany WHERE status != VERIFIED` | `src/app/api/gateway/verify/route.ts:49-55` | ✓ | ✓ | Atomic conditional update with count check. Closes the double-verify race. Verified by `payment-wallet-audit.test.ts` tests #4 (sequential) and #5 (concurrent Promise.all). |
| **GW-01** | `/api/gateway/initiate` validates amount ≤ 100M IRR | `src/app/api/gateway/initiate/route.ts:22-29` | ✓ | ✓ | Two checks: `amount <= 0` → 400, `amount > 100_000_000` → 400. Note: amount is STILL client-supplied (dev mode only — route 404s in prod). |

**Verified: 4/4 present. 3/4 fully correct. 1/4 (VIP-01) correct in spirit but non-atomic — see PAY-05.**

---

## 4. Idempotency Analysis per Route

### 4.1 `/api/gateway/initiate` (POST) — `src/app/api/gateway/initiate/route.ts`

- **Idempotency key / unique constraint:** ✗ None. Each call generates a NEW `code` (`PG-${random}`) and `referenceId` (`SIM-${Date.now()}-${random}`) and creates a new `PaymentGatewayLog` row.
- **Duplicate-create behavior:** Calling `/initiate` twice for the same logical "purpose" (e.g., VIP plan purchase) creates TWO separate gateway logs. The frontend is expected to track which log to verify.
- **Status guard:** ✗ None. Even if a previous initiation for the same `purpose` is still `REDIRECTED` (unverified), a new initiation creates a fresh log. The old log remains in `REDIRECTED` status indefinitely — orphaned.
- **Severity:** LOW (PAY-02). Orphaned gateway logs accumulate but do not affect money movement. Recommend: optional `purpose` + `userId` dedup (if a REDIRECTED log exists for the same purpose+user, return its `code` instead of creating a new one).

### 4.2 `/api/gateway/verify` (POST) — `src/app/api/gateway/verify/route.ts`

- **Idempotency:** ✓ **Atomic** via `updateMany WHERE status != VERIFIED` (GW-02 fix).
- **Duplicate-verify behavior:** First call → `count=1` → creates Payment + links gateway log. Second call → `count=0` → returns 400 "Already verified". NO double-credit.
- **Concurrent-verify behavior:** Verified by test #5 (`Promise.all([verify, verify])`). Mock returns `count=1` for one call, `count=0` for the other → exactly ONE `Payment.create` call.
- **Ownership check:** ✓ `log.userId !== session.userId` → 403 (line 44-46). Verified by test #4.
- **Amount consistency (GW-01):** The Payment created at verify uses `log.amount` (line 63: `amount: log.amount`), NOT a client-supplied amount. Consistent with initiate.
- **Gap:** ✗ The three writes (`updateMany` → `payment.create` → `paymentGatewayLog.update`) are NOT in a transaction. If the process crashes between steps 1 and 3, the log is VERIFIED but no Payment record exists. A replay would return 400 (log is VERIFIED) → user loses money verification. **Severity: MEDIUM (PAY-03).** Recommend: wrap in a D1-compatible transaction or use a `paymentId` link on the gateway log with `@@unique` to make step 3 idempotent.

### 4.3 `/api/payments` (POST) — `src/app/api/payments/route.ts`

- **Idempotency:** Partial.
  - **Invoice-level idempotency:** ✓ `invoice.updateMany WHERE status != PAID` (line 114-117 and 162-165). If invoice is already PAID, `invResult.count === 0` → side effects (job completion, warranty, notification) are skipped.
  - **Pre-check:** ✓ Line 91-96 — if `inv.status === "PAID"` at fetch time, returns 409 `alreadyPaid: true`.
  - **Payment-record idempotency:** ⚠️ Schema-level only. `Payment.invoiceId` is `@unique` (schema.prisma:412), so a second `payment.create` with the same `invoiceId` fails at the DB level with a unique-constraint violation. **BUT the route has NO try/catch around `payment.create` (line 148-158)** → the second concurrent request throws an unhandled error → Next.js returns a generic 500. The user sees an opaque server error instead of a graceful 409.
- **Concurrent duplicate POST:** Two requests racing past the `existing === null` check (line 104) both attempt `payment.create`. The DB rejects the second via unique constraint → 500 error. **Severity: MEDIUM (PAY-04).** The money is NOT double-charged (the invoice.updateMany guard prevents the side effects), but the UX is broken (opaque 500).
- **Existing-payment update path (line 107-109):** When `existing` is non-null, the route UPDATES the payment status (e.g., FAILED → SUCCEEDED on retry). This path is reachable ONLY if `inv.status !== PAID` at fetch time — so it's the "retry after failure" path, not a duplicate-success path. Acceptable. (Edge case: if `inv.status` lookup was stale and saw SENT when it was actually PAID, the update could downgrade SUCCEEDED → FAILED. Unlikely with Prisma's default read consistency. Severity: LOW.)
- **BOLA:** ✓ `job.request.customer.userId !== session.userId` → 403 (line 77-82). Verified by test #2.
- **Production guard:** ✓ PAY-01 (line 29-31). Verified by test #1.
- **Rate limit:** ✓ `rateLimitAsync` with `RATE_LIMITS.PAYMENT` (line 37-47). Mocked to always succeed in tests.

### 4.4 `/api/wallets/withdraw` (POST) — `src/app/api/wallets/withdraw/route.ts`

- **Idempotency:** ✗ No idempotency key. Each call creates a NEW `WithdrawalRequest` with a fresh `code` (`WD-${random}`).
- **Duplicate-debit prevention:** ✓ **Atomic** via `wallet.updateMany WHERE id, balance >= amount` (line 82-85, SEC-9 fix). If a concurrent withdraw already deducted enough to make `balance < amount`, the WHERE clause matches 0 rows → `count === 0` → throws "موجودی توسط درخواست هم‌زمان تغییر کرد" → returns 400.
- **Order of operations:** ✓ Correct after B2.2 fix. Atomic decrement happens BEFORE `withdrawalRequest.create`. If decrement fails, NO `WithdrawalRequest` row exists (no orphaned-request payout).
- **Stale-balance fix:** ✓ After decrement, the route RE-READS the wallet (line 95: `db.wallet.findUnique`) to get the actual post-decrement balance, then uses it for the ledger `balanceAfter` (line 120) AND the response `newBalance` (line 139). This closes the SEC-9 stale-balance regression.
- **Negative-balance prevention:** ✓ The `WHERE balance >= amount` clause guarantees balance cannot go negative. Verified by test #6 (exceeds balance → 400, no mutation) and control test (within balance → 200 with correct WHERE clause).
- **Audit trail on failure:** ✗ When the atomic decrement fails (race loser), NO ledger entry is created and NO `WithdrawalRequest` is created. The failed attempt is invisible to admins. **Severity: LOW (PAY-08).** This is the intentional B2.2 trade-off (no orphaned requests), but a `walletLedger.create` with `type: "WITHDRAWAL_FAILED"` would aid reconciliation.

### 4.5 `/api/vip/subscribe` (POST) — `src/app/api/vip/subscribe/route.ts`

- **Idempotency:** ⚠️ **Non-atomic (TOCTOU).** The VIP-01 fix (line 62-68) does `findFirst` + check + `create`. Two concurrent subscribes with the same `paymentId` can both pass the `findFirst` check (both see null) and both call `create`. Schema has NO `@@unique` on `UserVipSubscription.paymentId`.
- **Demonstrated by test:** `it.fails()` test #14 — `Promise.all([subscribe, subscribe])` with same paymentId → both `200`, TWO `create` calls. Test is marked `it.fails()` so the suite stays green; the test "fails" as expected, documenting the bug.
- **Payment validation:** ✓ Solid (line 52-60). Checks: payment exists, belongs to caller, status === SUCCEEDED, amount >= plan.priceIrr.
- **Subscription replacement:** ✓ Existing ACTIVE subscriptions are cancelled via `updateMany WHERE userId, status: ACTIVE` (line 71-74) before creating the new one. Atomic per-row, but the cancel+create sequence is NOT atomic across rows.
- **Severity:** HIGH (PAY-05). A `@@unique` constraint on `UserVipSubscription.paymentId` would backstop the application-level check.

### 4.6 `/api/wallets` (GET) — `src/app/api/wallets/route.ts`

- **Auto-release idempotency:** ✓ **Atomic** via `walletTransaction.updateMany WHERE id, status = PENDING` (SEC-8 fix, line 65-68). Only the race winner (count=1) applies the wallet delta; the loser (count=0) skips the wallet update.
- **Re-verified by existing test:** `tests/unit/wallets-auto-release.test.ts` (5 tests, all pass).

### 4.7 `/api/prepay` (POST) — `src/app/api/prepay/route.ts`

- **Idempotency:** ✓ Two-layer.
  - Pre-check at line 63: `if (job.prepayPaid) return { ok: true, alreadyPaid: true, ... }` — fast path.
  - Atomic update at line 94: `job.updateMany WHERE id, prepayPaid: false`. If a concurrent request already set `prepayPaid=true`, `count === 0` → returns `{ ok: true, alreadyPaid: true, message: "Pre-service payment already paid (concurrent request)" }` (line 107-114).
- **Wallet credit:** ✓ Recorded as a PENDING `WalletTransaction` (line 138-150). Released later by `/api/wallets` auto-release.
- **Server-authoritative amount:** ✓ `inspectionFee`, `travelFee`, `commission`, `net` are all derived from the technician's profile + vehicle type (line 78-84), NOT from the client.

### 4.8 `/api/invoices` (POST) + `/api/invoices/[id]` (PATCH)

- **Idempotency:** ✗ None. Creating an invoice for the same `jobId` twice: `Invoice.jobId` is `@unique` (schema.prisma:379) → second create fails with unique-constraint violation → unhandled throw → 500. Same pattern as `/api/payments`. Severity: LOW (PAY-09).
- **Status transitions:** ✓ Enforced. PATCH route (line 64-83) only allows `DRAFT → SENT` (technician/admin) and `→ CANCELLED` (technician/admin). Direct `PAID` transition is forbidden for everyone — must go through `/api/payments`.

---

## 5. Race Condition Analysis

### 5.1 Gateway verify (concurrent callbacks)

**Flow:** `findUnique(log)` → check `userId` → `updateMany WHERE status != VERIFIED` → `payment.create` → `paymentGatewayLog.update(paymentId)`.

**TOCTOU window:** ✗ Between `findUnique` and `updateMany`, BUT the `updateMany` is atomic with the WHERE precondition. So even if two requests both see the same REDIRECTED log, only ONE can transition it to VERIFIED (the other gets count=0).

**Verdict:** ✓ **Race-safe** for the verify step itself (GW-02 fix). Verified by concurrent test #5.

**Residual risk:** The three writes after `updateMany` are non-transactional. A crash between `updateMany` and `payment.create` leaves the log VERIFIED but no Payment row. Reconciliation needed. (PAY-03.)

### 5.2 Payments (concurrent POSTs for same invoice)

**Flow:** `findUnique(invoice)` → ownership check → `if PAID return 409` → `findUnique(payment by invoiceId)` → if existing, UPDATE; else CREATE → `invoice.updateMany WHERE status != PAID` → side effects.

**TOCTOU windows:**
1. Between `invoice.findUnique` (line 62) and `invoice.updateMany` (line 114/162): both requests see `status: SENT`. The `updateMany WHERE status != PAID` makes the invoice transition atomic — only one wins.
2. Between `payment.findUnique` (line 104) and `payment.create` (line 148): both see null, both attempt create. DB unique constraint on `invoiceId` rejects the second → unhandled 500.

**Verdict:** ⚠️ **Money-safe** (no double-charge — invoice guard prevents side effects) **but UX-broken** (concurrent duplicate returns opaque 500). PAY-04.

### 5.3 Wallet withdraw (concurrent withdrawals)

**Flow:** `wallet.findUnique` → `if balance < amount return 400` → (try) re-check balance → `wallet.updateMany WHERE balance >= amount` → re-read wallet → `withdrawalRequest.create` → `walletLedger.create` → `notification.create`.

**TOCTOU window:** Between the initial `findUnique` and the `updateMany`, BUT the `updateMany WHERE balance >= amount` is atomic — only one withdraw can decrement enough to push `balance < amount`. The loser gets `count=0` → throws → 400.

**Verdict:** ✓ **Race-safe.** Verified by existing `tests/unit/wallets-withdraw.test.ts` (2 tests) and new test #6.

### 5.4 Wallet auto-release (concurrent GET /api/wallets)

**Flow:** `wallet.findUnique` → filter PENDING txns past holdUntil → for each: `walletTransaction.updateMany WHERE id, status = PENDING` → if count=1, `wallet.update` (increment balance).

**TOCTOU window:** Between the filter and the updateMany, BUT the updateMany is atomic. Only one request transitions a txn to AVAILABLE.

**Verdict:** ✓ **Race-safe** (SEC-8 fix). Verified by existing `tests/unit/wallets-auto-release.test.ts` (5 tests).

### 5.5 VIP subscribe (concurrent subscribes with same paymentId)

**Flow:** `vipPlan.findUnique` → `payment.findUnique` (validate) → `userVipSubscription.findFirst WHERE paymentId, status in [ACTIVE, CANCELLED, EXPIRED]` → if found, 409 → else `updateMany WHERE userId, status: ACTIVE` (cancel existing) → `userVipSubscription.create`.

**TOCTOU window:** ⚠️ Between `findFirst` (line 63) and `create` (line 79), both requests see null → both create. The schema has NO `@@unique` on `paymentId` → both inserts succeed at DB level.

**Verdict:** ✗ **Race-unsafe** (VIP-01 TOCTOU). Demonstrated by `it.fails()` test #14. **Severity: HIGH (PAY-05).**

### 5.6 Prepay (concurrent POSTs for same job)

**Flow:** `job.findUnique` → `if job.prepayPaid return alreadyPaid` → `job.updateMany WHERE id, prepayPaid: false` → if count=0 return alreadyPaid → else side effects.

**TOCTOU window:** Between `findUnique` and `updateMany`, BUT the `updateMany WHERE prepayPaid: false` is atomic. Only one wins.

**Verdict:** ✓ **Race-safe.**

---

## 6. Status Transition Matrix

### 6.1 `Payment.status` (enum `PaymentStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `PENDING` (default) | `SUCCEEDED` | `/api/payments` POST (simulator: `Math.random() > 0.05`) | None (simulator) |
| `PENDING` (default) | `FAILED` | `/api/payments` POST (simulator: 5%) | None (simulator) |
| `PENDING` (default) | `SUCCEEDED` | `/api/gateway/verify` POST (always — no failure path) | None (simulator) |
| `SUCCEEDED` | `FAILED` | `/api/payments` POST duplicate (retry path, line 107-109) — **only if `inv.status !== PAID` at fetch** | Invoice status pre-check (line 91) |
| `FAILED` | `SUCCEEDED` | `/api/payments` POST retry (line 107-109) | Invoice status pre-check |
| `SUCCEEDED` | `REFUNDED` | (no route implements this) | n/a |
| `FAILED` | `REFUNDED` | (no route implements this) | n/a |

**Gap:** No explicit status-transition guard. The route trusts `Math.random()` for transitions. Severity: LOW in simulator (route 404s in prod); MUST be replaced with real gateway response before prod.

### 6.2 `PaymentGatewayLog.status` (enum `GatewayStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `INITIATED` (default) | `REDIRECTED` | `/api/gateway/initiate` POST (creates with `REDIRECTED`) | n/a (initial state set at create) |
| `REDIRECTED` | `VERIFIED` | `/api/gateway/verify` POST | ✓ Atomic `updateMany WHERE status != VERIFIED` (GW-02) |
| `REDIRECTED` | `FAILED` | (no route) | n/a |
| `REDIRECTED` | `CANCELLED` | (no route) | n/a |
| `VERIFIED` | (any) | (no route — terminal) | n/a |

**Gap:** A log stuck in `REDIRECTED` (user abandoned) is never transitioned to `FAILED` or `CANCELLED`. Orphaned logs accumulate. PAY-02 (LOW).

### 6.3 `Invoice.status` (enum `InvoiceStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `DRAFT` | `SENT` | `/api/invoices/[id]` PATCH (tech/admin) | ✓ Explicit allow-list (line 66-76) |
| `SENT` | `PAID` | `/api/payments` POST (simulator success) | ✓ Atomic `updateMany WHERE status != PAID` |
| `SENT` | `CANCELLED` | `/api/invoices/[id]` PATCH (tech/admin) | ✓ Explicit allow-list |
| `PAID` | `REFUNDED` | (no route) | n/a |
| Any | `DRAFT` | FORBIDDEN | ✓ Explicit reject (line 71-75) |
| Any | `PAID` via `/api/invoices/[id]` | FORBIDDEN | ✓ Explicit reject (line 77-83) — "must go through /api/payments" |

**Verdict:** ✓ Invoice status transitions are well-guarded.

### 6.4 `WalletTransaction.status` (enum `TxnStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `PENDING` (default for PREPAY) | `AVAILABLE` | `/api/wallets` GET auto-release | ✓ Atomic `updateMany WHERE status = PENDING` (SEC-8) |
| `AVAILABLE` | `PROCESSING` | (no route — admin/manual) | n/a |
| `PROCESSING` | `COMPLETED` | (no route — admin/manual) | n/a |
| `COMPLETED` | `FAILED` | (no route) | n/a |

### 6.5 `WithdrawalRequest.status` (enum `WithdrawalStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `REQUESTED` (default) | `APPROVED` | (admin route — not audited here) | n/a |
| `APPROVED` | `PAID` | (admin route) | n/a |
| `REQUESTED` / `APPROVED` | `REJECTED` | (admin route) | n/a |

### 6.6 `UserVipSubscription.status` (enum `VipStatus`)

| From | To | Trigger | Guard |
|---|---|---|---|
| `PENDING_PAYMENT` (default) | `ACTIVE` | (no route sets this — `subscribe` creates directly as ACTIVE) | n/a |
| `ACTIVE` | `CANCELLED` | `/api/vip/subscribe` POST (line 71-74) — cancels existing ACTIVE before creating new | ✓ Atomic `updateMany WHERE userId, status: ACTIVE` |
| `ACTIVE` | `EXPIRED` | `/api/vip/my` GET (auto-expire past `expiresAt`) | ✓ Atomic `updateMany WHERE userId, status: ACTIVE, expiresAt < now` |
| `CANCELLED` / `EXPIRED` | (any) | (terminal — no route) | n/a |

---

## 7. Ledger / Balance Consistency Findings

### 7.1 Verify credits wallet exactly once?

**Note:** `/api/gateway/verify` does NOT directly credit a wallet. It creates a `Payment` record (status SUCCEEDED) linked to the gateway log. The wallet credit happens LATER:
- For prepay flows: `/api/prepay` creates a PENDING `WalletTransaction` (released by `/api/wallets` auto-release).
- For VIP: there is no wallet credit — VIP subscription is granted directly.

So "wallet credited once" for verify means "Payment created once + paymentGatewayLog linked once". Verified by tests #4 and #5: exactly ONE `payment.create` call across duplicate and concurrent verify.

### 7.2 Amount consistency between initiate and verify (GW-01)

- `/api/gateway/initiate`: amount is client-supplied (line 20: `const { amount, ... } = body`). Validated: `amount > 0`, `amount <= 100_000_000`. Stored in `PaymentGatewayLog.amount` (line 39).
- `/api/gateway/verify`: amount is read from `log.amount` (line 63: `amount: log.amount`). NOT client-supplied.
- **Verdict:** ✓ Amount is server-authoritative at verify time. The client can request a different amount at initiate, but the verified amount is locked to the log.

### 7.3 Withdraw: balance checked atomically?

✓ Yes. `wallet.updateMany WHERE id, balance >= amount` is a single atomic SQL UPDATE. Balance cannot go negative. Verified by test #6 + existing `wallets-withdraw.test.ts`.

### 7.4 Stale balance in response?

✓ **Fixed (SEC-9).** After the atomic decrement, the route re-reads the wallet (line 95) and uses the ACTUAL post-decrement balance for:
- `walletLedger.balanceAfter` (line 120) — audit trail correct.
- Response `newBalance` (line 139) — UX correct.

### 7.5 VIP subscribe: VIP-01 payment reuse prevention mechanism

**Mechanism:** `findFirst WHERE paymentId, status in [ACTIVE, CANCELLED, EXPIRED]` (line 63-65). If a subscription already exists linked to this `paymentId` (in any non-pending state), returns 409.

**Verification:** ✓ Sequential duplicate (test #13 — first succeeds, second returns 409).
**Race condition:** ✗ Concurrent duplicate (test #14, `it.fails()`) — both pass the check, both create.

**Recommended fix:** Add `@@unique` constraint on `UserVipSubscription.paymentId` in `prisma/schema.prisma`:
```prisma
model UserVipSubscription {
  // ... existing fields ...
  paymentId String? @unique // ← add UNIQUE
  // ... or: @@unique([paymentId]) if nulls should be allowed multiple times
}
```
This makes the DB reject the second insert with a unique-constraint violation, which the route can catch and return as 409.

### 7.6 Incomplete request logging

| Route | Failed/mid-step recorded? |
|---|---|
| `/api/payments` | ✓ Payment record created with `FAILED` status when `Math.random() <= 0.05`. Auditable. |
| `/api/gateway/initiate` | ✓ `PaymentGatewayLog` created with `REDIRECTED` status. Even if user never verifies, the log persists. |
| `/api/gateway/verify` | ⚠️ Partial. If the gateway log doesn't exist → 404 (no audit trail of the attempt). If OTP is wrong → 400 (no audit trail). If `updateMany` returns count=0 → 400 "Already verified" (the original verify IS auditable via the log). |
| `/api/prepay` | ✓ `Job.prepayPaid` flag + `WalletTransaction` record created on success. On race-loser, returns `{ ok: true, alreadyPaid: true }` (auditable via the existing prepayPaid flag). |
| `/api/wallets/withdraw` | ✗ **No audit trail on failure.** When `updateMany` returns count=0 (race loser), NO `WithdrawalRequest`, NO `walletLedger`, NO `notification` is created. The failed attempt is invisible. (PAY-08 — intentional B2.2 trade-off but a reconciliation gap.) |
| `/api/vip/subscribe` | ⚠️ Subscription is created or rejected. Failed-payment validation (line 52-60) returns 400 without creating any record — but the underlying Payment record (with `FAILED` status) already exists from `/api/payments`, so the audit trail is preserved at the Payment level. |

### 7.7 Callback signature / authenticity

- `/api/gateway/verify`: ✗ **No signature validation.** Accepts any `otp` of length ≥ 4 (line 33-35). The `code` is the only identifier — if an attacker knows the `code` (e.g., from a leaked URL or MITM), they can verify the payment.
- **Mitigation:** The route is 404 in production (PAY-01 pattern). Before wiring a real gateway, the verify route MUST validate the gateway's HMAC/signature (Zarinpal/IDPay callback signatures).
- **Severity:** HIGH (PAY-06) — but only relevant when real gateway is wired. Currently mitigated by production guard.

### 7.8 No real money / no real gateway call

✓ **Confirmed.** No `fetch()` calls to real gateway APIs from any route handler. The only `fetch()` calls to `zarinpal.com` / `idpay.ir` are inside `payment-provider.ts` (dead code, §2.2). The simulator paths use `Math.random()`, hardcoded OTP acceptance, and direct DB writes — no network calls to payment gateways.

---

## 8. Negative / Concurrency Test Results

**Test file:** `tests/unit/payment-wallet-audit.test.ts` (NEW — additive, isolated, the ONE source change allowed).
**Total tests:** 14 (13 PASS + 1 expected-fail via `it.fails()`).
**Full suite impact:** 403 tests pass (was 389), 1 expected-fail, 0 regressions.

| # | Test case | Expected | Actual | Result | Finding |
|---|---|---|---|---|---|
| 1 | PAY-01: `/api/payments` returns 404 in `NODE_ENV=production` | 404, no DB calls | 404, no DB calls | ✅ PASS | PAY-01 verified correct |
| 2 | PAY-01 control: `/api/payments` does NOT 404 in `NODE_ENV=test` | not 404, DB called | 200, invoice fetched | ✅ PASS | Guard is NODE_ENV-specific |
| 3 | `/api/payments`: payment for another user's invoice | 403, no payment.create | 403, no create | ✅ PASS | BOLA guard correct |
| 4 | `/api/payments`: payment for own invoice (control) | 200, payment.create called | 200, 1 create | ✅ PASS | Happy path works |
| 5 | `/api/payments`: duplicate POST after invoice PAID | 409, `alreadyPaid: true` | 409, alreadyPaid=true | ✅ PASS | Invoice idempotency correct |
| 6 | GW-02: first verify succeeds, creates 1 Payment | 200, 1 payment.create, WHERE uses `status: { not: "VERIFIED" }` | 200, 1 create, WHERE matches | ✅ PASS | GW-02 atomic guard correct |
| 7 | GW-02: second verify (duplicate) returns 400, no extra Payment | first 200, second 400, 1 total create | 200, 400, 1 create | ✅ PASS | GW-02 idempotency verified |
| 8 | GW-02: verify for another user's gateway log | 403, no create | 403, no create | ✅ PASS | Ownership check correct |
| 9 | GW-02: concurrent verify (`Promise.all` of 2) | one 200 + one 400, exactly 1 payment.create | one 200 + one 400, 1 create | ✅ PASS | Atomic updateMany closes TOCTOU |
| 10 | `/api/wallets/withdraw`: amount > balance | 400, no wallet.updateMany | 400, 0 updateMany | ✅ PASS | Exceeds-balance guard correct |
| 11 | `/api/wallets/withdraw`: amount ≤ balance (control) | 200, updateMany with `WHERE balance >= amount` | 200, WHERE matches | ✅ PASS | SEC-9 atomic decrement correct |
| 12 | VIP-01: single subscribe (control) | 200, 1 create | 200, 1 create | ✅ PASS | Happy path works |
| 13 | VIP-01: sequential duplicate (after first committed) | first 200, second 409, 1 total create | 200, 409, 1 create | ✅ PASS | Sequential idempotency correct |
| 14 | **VIP-01 TOCTOU: concurrent subscribes with same paymentId** | exactly 1 create, statuses [200, 409] | **2 creates, statuses [200, 200]** | ❌ **EXPECTED FAIL** (`it.fails()`) | **PAY-05 (HIGH): VIP-01 race condition — non-atomic findFirst+check+create** |

**Suite total after adding test file:** `Test Files 21 passed (21)` / `Tests 402 passed | 1 expected fail (403)` — suite stays GREEN, the `it.fails()` marker documents the known bug without breaking CI.

---

## 9. Findings Table

| ID | File:Line | Severity | Description | Repro | Status | Fix |
|---|---|---|---|---|---|---|
| **PAY-01** | `src/app/api/payments/route.ts:29-31` | — (prior fix) | Production guard — payments route returns 404 in `NODE_ENV=production`. | `NODE_ENV=production` + `POST /api/payments` → 404. | ✓ Verified correct | n/a |
| **VIP-01** | `src/app/api/vip/subscribe/route.ts:62-68` | — (prior fix, partial) | Payment-reuse check via `findFirst` + 409. | Sequential duplicate → 409. | ⚠️ Sequential OK; race fails (PAY-05) | Convert to atomic guard (see PAY-05). |
| **GW-02** | `src/app/api/gateway/verify/route.ts:49-55` | — (prior fix) | Atomic `updateMany WHERE status != VERIFIED` + count check. | Duplicate or concurrent verify → exactly one Payment. | ✓ Verified correct | n/a |
| **GW-01** | `src/app/api/gateway/initiate/route.ts:22-29` | — (prior fix) | Amount validation: `> 0` and `<= 100M IRR`. | `POST /initiate { amount: 0 }` → 400; `amount: 100_000_001` → 400. | ✓ Verified correct | n/a |
| **PAY-02** | `src/app/api/gateway/initiate/route.ts:31-49` | LOW | No idempotency on initiate — each call creates a new `PaymentGatewayLog`. Orphaned `REDIRECTED` logs accumulate if user abandons. | Call `/initiate` twice for same purpose+user → 2 logs. | Open | Optional: dedup by `purpose + userId` if a `REDIRECTED` log exists. |
| **PAY-03** | `src/app/api/gateway/verify/route.ts:49-74` | MEDIUM | Three non-transactional writes: `updateMany` → `payment.create` → `paymentGatewayLog.update`. Crash between step 1 and 3 leaves log VERIFIED but no Payment record. Replay returns 400. | Hard to repro without crash injection. | Open | Wrap in D1 transaction OR make step 3 idempotent via `@@unique` on `PaymentGatewayLog.paymentId`. |
| **PAY-04** | `src/app/api/payments/route.ts:148-158` | MEDIUM | Concurrent duplicate POST: both pass `existing === null` check, both call `payment.create`. DB unique constraint rejects 2nd → unhandled throw → opaque 500. Money is NOT double-charged (invoice guard holds). | `Promise.all([POST /payments, POST /payments])` with same `invoiceId` → one 200, one 500. | Open | Wrap `payment.create` in try/catch; on unique-constraint violation, return 409 `alreadyPaid: true`. |
| **PAY-05** | `src/app/api/vip/subscribe/route.ts:63-79` | **HIGH** | VIP-01 TOCTOU: `findFirst` + check + `create` is non-atomic. Two concurrent subscribes with same `paymentId` both pass the check, both create ACTIVE subscriptions. Schema has NO `@@unique` on `UserVipSubscription.paymentId`. | `Promise.all([subscribe, subscribe])` with same paymentId → both 200, 2 creates. | **Open — demonstrated by `it.fails()` test #14.** | Add `@@unique` on `UserVipSubscription.paymentId` (or `paymentId` `@unique` if nulls are OK); catch unique-violation in route → return 409. |
| **PAY-06** | `src/app/api/gateway/verify/route.ts:30-35` | **HIGH** (gated by prod guard) | No callback signature validation. Accepts any `otp` of length ≥ 4. Anyone with the `code` can verify. | `POST /verify { code, otp: "1234" }` → 200 (regardless of OTP correctness). | Open — mitigated by 404 in prod | Before wiring real gateway: validate Zarinpal/IDPay HMAC signature. |
| **PAY-07** | `wrangler.toml:19` + all 5 payment routes | **HIGH** (config-foot-gun) | Payment-system security depends on a single `NODE_ENV === "production"` string match. If `NODE_ENV` is unset/changed in wrangler.toml, ALL payment routes become reachable in prod → simulator runs with real customers. | Edit `wrangler.toml` to `NODE_ENV = "development"` → routes become reachable. | Open — defense-in-depth needed | Also check `PAYMENT_PROVIDER !== "simulator"` in the guard, OR add a CI check on wrangler.toml. |
| **PAY-08** | `src/app/api/wallets/withdraw/route.ts:86-90` | LOW | Failed withdraw (race loser) leaves NO audit trail. No `WithdrawalRequest`, no `walletLedger`, no `notification`. Intentional B2.2 trade-off but a reconciliation gap. | Two concurrent withdraws where one loses → only one `walletLedger` row exists. | Open — intentional | Optional: create a `walletLedger` with `type: "WITHDRAWAL_FAILED"` on race-loss for audit. |
| **PAY-09** | `src/app/api/invoices/route.ts:99-118` | LOW | No idempotency on invoice create. `Invoice.jobId` is `@unique` → 2nd create throws → unhandled 500. | `POST /invoices` twice with same `jobId` → one 201, one 500. | Open | Wrap `invoice.create` in try/catch; on unique violation, return 409. |

---

## 10. Critical / High Blockers for Release

### Critical: 0

The simulator-only mode is safe to ship. The production guard (PAY-01 pattern) blocks all money-moving routes in `NODE_ENV=production`. The deployed `wrangler.toml` sets `NODE_ENV=production`, so the live Worker returns 404 for all five payment routes. No real money can move.

### High: 3 (none block current release; all block real-payment integration)

1. **PAY-05 — VIP-01 TOCTOU race** (`src/app/api/vip/subscribe/route.ts:63-79`). Two concurrent subscribes with the same `paymentId` can both create ACTIVE VIP subscriptions. Schema lacks `@@unique` on `UserVipSubscription.paymentId`. **Demonstrated by `it.fails()` test #14.** Safe in current dev-only mode (route 404s in prod) but MUST be fixed before any real payment integration.

2. **PAY-06 — No callback signature verification** (`src/app/api/gateway/verify/route.ts:30-35`). The verify route accepts any 4+ char OTP. Safe in current dev-only mode (route 404s in prod) but MUST be replaced with real Zarinpal/IDPay HMAC validation before wiring a real gateway.

3. **PAY-07 — Config-foot-gun: single env-var guard** (`wrangler.toml:19` + 5 route guards). The entire payment-system security depends on `NODE_ENV === "production"` being correctly set in `wrangler.toml`. If unset or changed, all payment routes become reachable in production. **Defense-in-depth recommendation:** also check `PAYMENT_PROVIDER !== "simulator"` (treat real-mode as opt-in), add a CI check on `wrangler.toml`, and expose `payment_mode` in `/api/health` for monitoring.

### Recommendation

- **For current PR #3 merge:** No blockers. Simulator-only mode is safe.
- **Before any real-payment integration:** Fix PAY-05, PAY-06, PAY-07. Add a CI check that fails if `wrangler.toml` has `NODE_ENV != "production"` OR `PAYMENT_PROVIDER != "simulator"`.
- **Nice-to-have:** PAY-03 (transactional verify writes), PAY-04 (graceful 409 on concurrent payment), PAY-08 (failed-withdraw audit trail), PAY-09 (graceful 409 on duplicate invoice), PAY-02 (initiate idempotency).

---

## Appendix A — Test File Summary

**File:** `tests/unit/payment-wallet-audit.test.ts` (NEW, additive, isolated — the ONE source change allowed by the task).

**Pattern:** Module-level `vi.mock` for `@/lib/db-access`, `@/lib/api-helpers`, `@/lib/rate-limit`, `@/lib/auth` (following the established pattern in `tests/unit/vip-subscribe.test.ts` and `tests/unit/wallets-withdraw.test.ts`). All DB calls are mocked — no D1/Prisma connection required. `NODE_ENV` stubbed per-test via `vi.stubEnv`.

**Coverage:**
- 5 required cases (PAY-01 prod guard, BOLA, duplicate verify, concurrent verify, withdraw exceeds balance) — all PASS.
- 9 supplementary cases (control happy-paths, BOLA on verify, sequential duplicate VIP, VIP-01 TOCTOU race) — 8 PASS + 1 `it.fails()`.

**`it.fails()` usage:** The VIP-01 TOCTOU test (test #14) uses `it.fails()` to assert that the bug STILL EXISTS. If a future fix makes the check atomic, the test will start to PASS — and `it.fails()` will flip the suite red, alerting the team to remove the `.fails` marker. This documents the bug without breaking CI.

**Suite impact:** `Test Files 21 passed (21)` / `Tests 402 passed | 1 expected fail (403)`. Up from `Test Files 20 passed (20)` / `Tests 389 passed (389)`. No regressions.

---

## Appendix B — Routes Audited

| # | Route | File | Audited? |
|---|---|---|---|
| 1 | POST `/api/payments` | `src/app/api/payments/route.ts` | ✓ |
| 2 | POST `/api/gateway/initiate` | `src/app/api/gateway/initiate/route.ts` | ✓ |
| 3 | POST `/api/gateway/verify` | `src/app/api/gateway/verify/route.ts` | ✓ |
| 4 | GET `/api/wallets` | `src/app/api/wallets/route.ts` | ✓ (auto-release race) |
| 5 | POST `/api/wallets/withdraw` | `src/app/api/wallets/withdraw/route.ts` | ✓ |
| 6 | POST `/api/vip/subscribe` | `src/app/api/vip/subscribe/route.ts` | ✓ |
| 7 | GET `/api/vip/my` | `src/app/api/vip/my/route.ts` | ✓ (auto-expire) |
| 8 | GET `/api/vip/plans` | `src/app/api/vip/plans/route.ts` | ✓ (public, no auth) |
| 9 | POST `/api/prepay` | `src/app/api/prepay/route.ts` | ✓ |
| 10 | GET/POST `/api/invoices` | `src/app/api/invoices/route.ts` | ✓ |
| 11 | PATCH `/api/invoices/[id]` | `src/app/api/invoices/[id]/route.ts` | ✓ (status transitions) |
| 12 | — | `src/lib/payment-provider.ts` | ✓ (dead-code finding §2.2) |
| 13 | — | `src/lib/vip.ts` | ✓ (not used by vip/subscribe route; used by care/bookings + pricing module) |
| 14 | — | `src/lib/pricing.ts` | ✓ (Decimal-safe money math; no race surface) |
| 15 | — | `wrangler.toml` | ✓ (PAYMENT_PROVIDER + NODE_ENV) |

**Routes audited: 15.**
