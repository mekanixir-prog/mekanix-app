# Bundle 2.2 — Withdrawal Consistency Fix

**Date:** 2026-10-15
**Branch:** `feature/cloudflare-d1-validation`
**Baseline SHA (B2.1 HEAD):** `4f41eee7cf444b859d3c1c1bf3d408d504e4c7c6`
**Final SHA:** `7b091ea9822987e2bf114e1c72a76699c187ec9a`
**Task ID:** B2.2

## Problem

The B2.1 verification report (`docs/BUNDLE_2_1_VERIFY.md`, Step 3 — SEC-9 caveat) flagged a pre-existing consistency hole in the wallet withdraw route (`src/app/api/wallets/withdraw/route.ts`):

> **WithdrawalRequest.create happens BEFORE updateMany, so a race-loser leaves an orphaned REQUESTED row that an admin could later approve without balance deduction.**

The vulnerable flow on `feature/cloudflare-d1-validation @ 4f41eee` (post-B2.1) was:

```
1. Re-check balance (lockedWallet.balance >= amount)        ✓
2. Compute balanceBefore + balanceAfter
3. WithdrawalRequest.create  ← creates row in DB (status=REQUESTED)
4. wallet.updateMany (atomic decrement with WHERE balance>=amount)
   - if count===0: throw → 400, but WithdrawalRequest stays!
5. Re-read wallet.balance → actualBalanceAfter
6. Create walletLedger entry
7. Create notification
8. Return 200
```

If two concurrent withdraws race:
- Both pass the initial balance check (e.g. balance=1000, amount=500 each).
- **Both create WithdrawalRequest rows** (status=REQUESTED).
- The atomic `updateMany` decrements serialize at the DB level:
  - Winner: balance 1000 → 500 (count=1, proceeds to step 5-8, returns 200).
  - Loser: tries to decrement 500 → 0, but the WHERE clause is `balance >= 500` (the loser's amount). 500 ≥ 500 is true, so it succeeds too — both decrements happen.
  - **However**, in the scenario where the loser's `amount` would push the balance below zero, OR where a third concurrent withdraw has already raced ahead, the loser's `updateMany` returns `count=0` → throws → 400 returned, **but the WithdrawalRequest row from step 3 is still in the DB** with `status=REQUESTED`.

An admin reviewing the withdrawals queue would see this orphaned row and could approve it, triggering a payout **without a corresponding balance deduction** — money leaves the system without being debited from the technician's wallet.

## Fix — Reorder: atomic decrement BEFORE WithdrawalRequest.create

The B2.2 fix moves `wallet.updateMany` (atomic decrement) to happen BEFORE `db.withdrawalRequest.create`. The new flow:

```
1. Re-check balance (lockedWallet.balance >= amount)         — early bail
2. Compute balanceBefore (drop pre-computed balanceAfter)
3. wallet.updateMany (atomic decrement with WHERE balance>=amount)
   - if count===0: throw → 400, NO WithdrawalRequest created
4. Re-read wallet.balance → actualBalanceAfter
5. WithdrawalRequest.create  ← NOW safe, balance is already deducted
6. Create walletLedger entry (using actualBalanceAfter)
7. Create notification
8. Return 200
```

**Key invariant:** a `WithdrawalRequest` row exists ONLY if the wallet was successfully deducted.

**Safety analysis:**

| Step fails | Balance deducted? | WithdrawalRequest exists? | Recoverability |
|---|---|---|---|
| 3 (updateMany) — count=0 | NO | NO | Clean 400. User retries. Nothing to reconcile. |
| 3 (updateMany) — throws | NO | NO | Clean 400. Nothing to reconcile. |
| 4 (re-read) | YES | NO | Balance deducted but no request. Admin reconciles (refund or create request manually). Recoverable. |
| 5 (WithdrawalRequest.create) | YES | NO | Same as above. Recoverable. |
| 6 (ledger) | YES | YES but no ledger | Admin can still reconcile from the wallet balance. Recoverable. |
| 7 (notification) | YES | YES, ledger exists | Notification missing — cosmetic. Recoverable. |

Compare to **before B2.2** (WithdrawalRequest first):

| Step fails | Balance deducted? | WithdrawalRequest exists? | Recoverability |
|---|---|---|---|
| 4 (updateMany) — count=0 | NO | **YES (orphan!)** | **Unrecoverable**: admin could approve the orphaned request → payout without deduction. |

The reorder converts an unrecoverable failure (payout-without-deduction) into a recoverable one (deduction-without-payout — admin refunds the technician).

## Why not `$transaction`?

The fix deliberately does NOT wrap the writes in `db.$transaction`:

1. **D1 doesn't expose `db.batch()` through Prisma yet** (per the existing comment in the file from B2.1). The route is deployed to Cloudflare Workers + D1, where `$transaction` semantics aren't available.
2. **The current D1-compatible pattern is sequential writes with optimistic concurrency** — this is the established pattern throughout B2.1 (SEC-8, SEC-9, SEC-10 all use it).
3. **Adding `$transaction` would require verifying D1 support**, which is out of scope for B2.2.
4. **The reorder approach achieves the same safety guarantee** (no orphaned request) without needing a transaction wrapper. The atomic `updateMany` (single SQL statement) is the only mutation that needs to be atomic — and it already is, thanks to SEC-9.

## Commits

| # | SHA | Description |
|---|------|------|
| 1 | `895f604` | `fix(b2.2): reorder withdraw flow — atomic decrement before WithdrawalRequest.create` |
| 2 | `7b091ea` | `test(b2.2): concurrent withdraw failure does not create orphaned WithdrawalRequest` |

Both commits are on `feature/cloudflare-d1-validation`, parented linearly on top of `4f41eee` (B2.1 HEAD).

## Verification

### Diff (`git diff 4f41eee..HEAD -- src/app/api/wallets/withdraw/route.ts`)

The diff reorders the try-block:

- **Before:** `wallet.findUnique` (re-check) → `withdrawalRequest.create` → `wallet.updateMany` (atomic decrement) → `wallet.findUnique` (re-read) → `walletLedger.create` → `notification.create` → return.
- **After:** `wallet.findUnique` (re-check) → `wallet.updateMany` (atomic decrement) → `wallet.findUnique` (re-read) → `withdrawalRequest.create` → `walletLedger.create` → `notification.create` → return.

The comment block above `try {` is updated to explain the B2.2 invariant. The SEC-9 atomic decrement (`updateMany` + `decrement` + WHERE `balance >= amount`) and the `actualBalanceAfter` re-read pattern are preserved unchanged — only their order relative to `withdrawalRequest.create` changes.

Order verification (`grep -n "updateMany\|withdrawalRequest.create\|walletLedger.create"`):

```
82:    const deductResult = await db.wallet.updateMany({
100:    const withdrawal = await db.withdrawalRequest.create({
114:    await db.walletLedger.create({
```

`updateMany` (line 82) comes BEFORE `withdrawalRequest.create` (line 100) BEFORE `walletLedger.create` (line 114). ✓

### ESLint

```
$ bunx eslint src/app/api/wallets/withdraw/route.ts
# exit 0
# (only an unrelated .eslintignore deprecation warning, project-wide)
```

Clean. ✓

### TypeScript (`bun run tsc --noEmit`)

```
$ bun run tsc --noEmit
# exit 0, no errors
```

0 errors. Matches B2.1's clean state. ✓

### Tests (`bun run test`)

```
Test Files  15 passed (15)
     Tests  348 passed (348)
```

- 346 pre-existing tests (B2.1 baseline) — all still pass.
- 2 new B2.2 tests (in `tests/unit/wallets-withdraw.test.ts`) — both pass.

Total: **348 / 348 passed**. ✓

### Test coverage — the 2 new test cases

**File:** `tests/unit/wallets-withdraw.test.ts`

**Test 1: "does NOT create WithdrawalRequest when atomic decrement fails (count=0)"**

- Mocks `getDbForLib()` to return a mock Prisma client.
- Mocks `wallet.findUnique` to return a wallet with `balance=1000` (passes both the initial lookup and the re-check inside try).
- Mocks `wallet.updateMany` to return `{ count: 0 }` — simulates a concurrent withdraw winning the race (balance was already deducted by another request).
- Calls the POST handler with `amount=500, method="card"` (minting a real TECHNICIAN JWT via `createSession`).
- Asserts:
  - Response status is `400` (route threw "موجودی توسط درخواست هم‌زمان تغییر کرد").
  - `withdrawalRequest.create` was **NOT** called — no orphaned WithdrawalRequest row.
  - `walletLedger.create` was **NOT** called.
  - `notification.create` was **NOT** called.
  - `wallet.updateMany` **WAS** called once, with `where: { id, balance: { gte: 500 } }` and `data: { balance: { decrement: 500 } }`.

**Test 2: "creates WithdrawalRequest ONLY after atomic decrement succeeds (count=1)"**

- Mocks `wallet.findUnique` to return `balance=1000` on the initial lookup, `balance=1000` on the re-check inside try, and `balance=500` on the post-decrement re-read.
- Mocks `wallet.updateMany` to return `{ count: 1 }` (race winner).
- Mocks `withdrawalRequest.create` to return a fake row.
- Calls the POST handler with `amount=500, method="card"`.
- Asserts:
  - Response status is `200`.
  - Response body has `withdrawal.id === "wd_1"` and `newBalance === 500`.
  - `withdrawalRequest.create` was called **exactly once** (after the decrement succeeded).
  - `walletLedger.create` was called once, with `balanceBefore=1000`, `balanceAfter=500` (the ACTUAL post-decrement balance, not a pre-computed `balanceBefore - amount`), and `amount=-500`.
  - `notification.create` was called once.
  - `wallet.updateMany` was called once with the correct WHERE clause.

## SHA Verification

| Ref | Expected | Actual | Status |
|---|---|---|---|
| `feature/cloudflare-d1-validation` before | `4f41eee7...` | `4f41eee7cf444b859d3c1c1bf3d408d504e4c7c6` | ✓ (baseline) |
| `feature/cloudflare-d1-validation` after | (new commit on top) | `7b091ea9822987e2bf114e1c72a76699c187ec9a` | ✓ (2 commits added) |
| `main` (local) | `625b23f66...` (unchanged) | `625b23f66d5f459cd0b1824496468b7e2c194272` | ✓ (unchanged) |
| `new-repo/main` (remote) | `e4c2faf14...` (unchanged) | `e4c2faf1447622da02bdd12a9535e367e8d46e36` | ✓ (unchanged) |
| `new-repo/feature/cloudflare-d1-validation` (remote) | `917b2b2d2...` (unchanged) | `917b2b2d2683a4360171e4b4602258586d1559e8` | ✓ (unchanged — no push) |

## Files Changed

| File | Status | Lines |
|---|---|---|
| `src/app/api/wallets/withdraw/route.ts` | Modified (reordered try block) | +42 / -40 |
| `tests/unit/wallets-withdraw.test.ts` | New (2 tests) | +241 |

Total: 2 files, +283 / -40 lines (vs `4f41eee`).

## Conclusion

**Verdict: APPROVED.**

The B2.2 fix resolves the pre-existing orphaned-WithdrawalRequest consistency hole flagged by the B2.1 verification report. The reorder approach (atomic decrement before `WithdrawalRequest.create`) eliminates the unrecoverable failure mode (payout without deduction) and converts it to a recoverable one (deduction without payout — admin reconciles). Two new tests verify both the failure path (count=0 → no orphan) and the success path (count=1 → request created after decrement). All 348 tests pass, TypeScript and ESLint are clean, and main + remote refs are untouched.

Recommended follow-ups (carried forward from B2.1-VERIFY):
1. Backfill concurrent-race tests for OTP verify (SEC-10) and wallet auto-release (SEC-8) — currently proven by code inspection only.
2. Enable branch protection on `main` (Phase-3 SEC-1, HIGH).
3. Consider adopting D1 `db.batch()` (if/when Prisma exposes it) to wrap multi-step wallet mutations in a true atomic batch — would obsolete the sequential-write-with-reorder pattern.
