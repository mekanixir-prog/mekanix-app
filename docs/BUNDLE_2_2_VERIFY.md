# Bundle 2.2 — Independent Verification Report

**Date:** 2026-10-15
**Reviewer:** Independent agent (read-only)
**Branch:** `feature/cloudflare-d1-validation` @ `ccd7aa254348ed01d6b363586b235bf8908cef6e`
**Baseline:** B2.1 HEAD @ `4f41eee7cf444b859d3c1c1bf3d408d504e4c7c6`
**Task ID:** B2.2-VERIFY

## Executive Summary

| Check | Result |
|---|---|
| Fix correct (reorder: updateMany BEFORE withdrawalRequest.create) | **YES** |
| Orphaned-WithdrawalRequest issue resolved | **YES** |
| Tests | **348 / 348 passed** (15 files) |
| TypeScript (`bun run tsc --noEmit`) | **0 errors** |
| ESLint on modified files | **CLEAN** (exit 0; only an unrelated `.eslintignore` deprecation warning) |
| Files changed | **4** (expected 4: fix + test + report + worklog) |
| main (local) untouched | **YES** (`625b23f`) |
| main remote untouched | **YES** (`e4c2faf`) |
| feature remote untouched (no push) | **YES** (`917b2b2`) |
| Overall verdict | **APPROVED** |

## Git State Verification

```
=== feature HEAD ===
ccd7aa254348ed01d6b363586b235bf8908cef6e

=== commits added since B2.1 ===
ccd7aa2 docs(b2.2): Bundle 2.2 report + worklog entry for orphaned-WithdrawalRequest fix
7b091ea test(b2.2): concurrent withdraw failure does not create orphaned WithdrawalRequest
895f604 fix(b2.2): reorder withdraw flow — atomic decrement before WithdrawalRequest.create

=== main local ===
625b23f66d5f459cd0b1824496468b7e2c194272    (UNCHANGED — matches baseline)

=== main remote (new-repo/main) ===
e4c2faf1447622da02bdd12a9535e367e8d46e36   (UNCHANGED — matches baseline)

=== feature remote (new-repo/feature/cloudflare-d1-validation) ===
917b2b2d2683a4360171e4b4602258586d1559e8   (UNCHANGED — no push occurred)
```

The 3 commits form a linear chain on top of `4f41eee` (B2.1 HEAD). No force-push, no rebase onto main, no merge of PR #3. The remote feature ref is unchanged, confirming no push happened.

## Fix Verification

### The reorder — line-by-line proof

Inspecting `src/app/api/wallets/withdraw/route.ts` at HEAD (`ccd7aa2`):

| Line | Operation | Step | Write? |
|------|-----------|------|--------|
| 43 | `db.wallet.findUnique` (initial lookup) | pre-try | read-only |
| 72 | `db.wallet.findUnique` (re-check inside try) | Step 1 | read-only |
| 74 | `throw new Error("موجودی کافی نیست")` if insufficient | — | no write |
| **82** | **`db.wallet.updateMany` (atomic decrement)** | **Step 2** | **WRITE (atomic SQL)** |
| 86 | `if (deductResult.count === 0)` | — | — |
| 89 | `throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد…")` | — | no write (orphan-prevention guard) |
| 95 | `db.wallet.findUnique` (post-decrement re-read) | Step 3 | read-only |
| **100** | **`db.withdrawalRequest.create`** | **Step 4** | **WRITE (only if Step 2 succeeded)** |
| **114** | **`db.walletLedger.create`** | **Step 5** | WRITE |
| **128** | **`db.notification.create`** | **Step 6** | WRITE |

**Order verification (grep of operations at HEAD):**

```
82:    const deductResult = await db.wallet.updateMany({
86:    if (deductResult.count === 0) {
89:      throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید");
100:    const withdrawal = await db.withdrawalRequest.create({
114:    await db.walletLedger.create({
128:    await db.notification.create({
```

✅ `wallet.updateMany` (line 82) comes BEFORE `withdrawalRequest.create` (line 100) BEFORE `walletLedger.create` (line 114) BEFORE `notification.create` (line 128).

### The orphan-prevention invariant — step-by-step proof

**Invariant under test:** A `WithdrawalRequest` row can ONLY exist in the DB if the wallet was successfully deducted by the same atomic SQL `updateMany`.

Walking the flow:

1. **Step 1 — `wallet.findUnique` (line 72, read-only):** Re-checks the balance after the route's initial balance check. If insufficient → `throw` (line 74) → caught by outer `catch` → returns 400. **No writes have occurred.** No `WithdrawalRequest` can exist.

2. **Step 2 — `wallet.updateMany` (line 82, atomic SQL write):** Issues a single atomic SQL `UPDATE wallet SET balance = balance - ? WHERE id = ? AND balance >= ?`. Three possible outcomes:
   - **`count === 0`** (race loser or insufficient balance at SQL-time): `throw` at line 89 → caught → 400. **No `WithdrawalRequest` was created.** ← **THIS IS THE ORPHAN-PREVENTION GUARD**
   - **`count === 1`** (winner): balance IS decremented atomically. Proceed to Step 3.
   - **Throws (DB error, network, etc.):** caught by outer `catch` → 400. Balance not deducted; no `WithdrawalRequest` was created.

3. **Step 3 — `wallet.findUnique` (line 95, read-only):** Re-reads the post-decrement balance for use in the ledger. Read-only — no state change. Even if it throws, balance is already deducted but no `WithdrawalRequest` exists.

4. **Step 4 — `withdrawalRequest.create` (line 100, write):** Reached ONLY if Step 2 succeeded (balance already deducted). Even if this throws, balance is deducted but no `WithdrawalRequest` exists → recoverable (admin reconciles), NOT a payout-without-deduction.

5. **Step 5 — `walletLedger.create` (line 114, write):** Uses `balanceBefore` (Step 1's value) and `actualBalanceAfter` (Step 3's re-read value, NOT a pre-computed `balanceBefore - amount`). Even if it throws, balance is deducted and `WithdrawalRequest` exists → only the audit trail is missing, NOT a payout-without-deduction.

6. **Step 6 — `notification.create` (line 128, write):** Even if it throws, all the financial state is correct — only the user notification is missing. Cosmetic.

**Conclusion:** There is NO code path in which `withdrawalRequest.create` (Step 4) executes without `wallet.updateMany` (Step 2) having returned `count === 1`. The orphan-prevention invariant holds.

### Other fix-correctness checks

| Check | Result |
|---|---|
| `walletLedger` uses `actualBalanceAfter` (re-read value, line 95), NOT a stale `balanceAfter` | ✅ Verified at line 114: `balanceAfter: actualBalanceAfter` |
| No escaped backticks (`\``) in the file | ✅ Verified via grep — 0 matches |
| SEC-9 atomic decrement pattern preserved | ✅ `data: { balance: { decrement: amount } }` with `where: { id, balance: { gte: amount } }` — both present at lines 82-85 |
| Comment block above `try` updated to document B2.2 invariant | ✅ (lines ~55-69 in the file) |
| Error message in Persian for the count=0 case | ✅ `"موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید"` |
| Outer `catch` returns 400 with the error message | ✅ (lines ~136-138) |

### Edge case analysis

| Step fails | Balance deducted? | WithdrawalRequest exists? | Severity | Recoverability |
|---|---|---|---|---|
| Step 1 (findUnique re-check) — insufficient balance | NO | NO | Clean | Nothing to reconcile. User retries. |
| Step 2 (updateMany) — `count === 0` | **NO** | **NO** | **Clean** | **Orphan-prevention guard fired. No state to reconcile.** |
| Step 2 (updateMany) — throws (DB error) | NO | NO | Clean | Caught → 400. Nothing to reconcile. |
| Step 3 (findUnique re-read) — throws | YES | NO | Recoverable | Balance deducted, no request. Admin reconciles (refund the technician or create the request manually). |
| Step 4 (withdrawalRequest.create) — throws | YES | NO | Recoverable | Same as above. Balance deducted, no payout. Admin refunds. |
| Step 5 (walletLedger.create) — throws | YES | YES | Recoverable | Balance deducted, request exists, ledger missing. Audit trail incomplete but no payout-without-deduction. Admin can reconcile from the wallet balance directly. |
| Step 6 (notification.create) — throws | YES | YES, ledger exists | Cosmetic | Notification missing. User not alerted. Financial state correct. |

**Comparison to pre-B2.2 (the vulnerable state):**

| Step fails (pre-B2.2) | Balance deducted? | WithdrawalRequest exists? | Severity |
|---|---|---|---|
| Step 4 (updateMany) — `count === 0` | **NO** | **YES (orphan!)** | **UNRECOVERABLE** — admin could approve the orphaned `WithdrawalRequest` → payout without deduction |

The B2.2 reorder converts an **unrecoverable** failure (payout-without-deduction) into a **recoverable** one (deduction-without-payout — admin refunds the technician). This is the correct fix.

## Test Verification

**File:** `tests/unit/wallets-withdraw.test.ts` (new, 241 lines, 2 tests)

### Test 1: "does NOT create WithdrawalRequest when atomic decrement fails (count=0)"

**Real test?** ✅ Yes — not `expect(true).toBe(true)`. The test:

- Mocks `getDbForLib()` to return a mock Prisma client with `wallet.findUnique`, `wallet.updateMany`, `withdrawalRequest.create`, `walletLedger.create`, `notification.create` all stubbed.
- Mocks `wallet.findUnique` to return `balance=1000` (passes both initial and re-check).
- Mocks `wallet.updateMany` to return `{ count: 0 }` — simulates a concurrent withdraw winning the race.
- Mints a real TECHNICIAN JWT via `createSession()` (matches the `care.test.ts` pattern, using the `node` vitest environment for cross-realm JWT signing).
- Calls `POST(req)` with `{ amount: 500, method: "card" }`.

**Assertions:**

1. `res.status === 400` — the route threw the Persian race-condition error.
2. `mockWithdrawalRequestCreate` was **NOT** called — **the orphan-prevention invariant is directly verified.** ✅
3. `mockWalletLedgerCreate` was **NOT** called.
4. `mockNotificationCreate` was **NOT** called.
5. `mockWalletUpdateMany` was called exactly **once**, with `where: { id: "wallet_1", balance: { gte: 500 } }` and `data: { balance: { decrement: 500 } }` — confirms the SEC-9 atomic decrement pattern is invoked.

This test directly proves the orphan-prevention guarantee.

### Test 2: "creates WithdrawalRequest ONLY after atomic decrement succeeds (count=1)"

**Real test?** ✅ Yes. The test:

- Mocks `wallet.findUnique` to return `balance=1000` (initial), `balance=1000` (re-check), and `balance=500` (post-decrement re-read) in sequence.
- Mocks `wallet.updateMany` to return `{ count: 1 }` — race winner.
- Mocks `withdrawalRequest.create` to return a fake row `{ id: "wd_1", code: "WD-123456", ... }`.
- Calls `POST(req)` with `{ amount: 500, method: "card" }`.

**Assertions:**

1. `res.status === 200`.
2. `body.withdrawal.id === "wd_1"` and `body.newBalance === 500`.
3. `mockWithdrawalRequestCreate` was called exactly **once** (after the decrement succeeded — confirmed by the order of `mockResolvedValueOnce` queue consumption).
4. `mockWalletLedgerCreate` was called once with `balanceBefore=1000`, `balanceAfter=500` (the **ACTUAL** post-decrement balance from the re-read, NOT a pre-computed `balanceBefore - amount`), `amount=-500`. ← **This verifies the `actualBalanceAfter` correctness check.** ✅
5. `mockNotificationCreate` was called once.
6. `mockWalletUpdateMany` was called once with the correct WHERE clause.

This test confirms the happy path and verifies that the ledger uses the re-read `actualBalanceAfter`, not a stale `balanceAfter`.

### Test coverage assessment

**Coverage of the orphan-prevention invariant: STRONG.**

The 2 tests directly cover:
- The `count === 0` race-loser path → no `WithdrawalRequest` created.
- The `count === 1` race-winner path → `WithdrawalRequest` created after decrement, ledger uses `actualBalanceAfter`.

**Minor gaps (NOT blocking):**

1. **Step 2 throws (DB error, not count=0):** Not tested explicitly. The route's outer `catch` would handle it (return 400). The orphan-prevention guarantee still holds (no `WithdrawalRequest` was created before the throw), but a test asserting this would be slightly more robust.
2. **Step 4 (`withdrawalRequest.create`) throws:** Not tested. The invariant still holds (balance deducted, no request → recoverable), but no test verifies this branch.
3. **Step 1 insufficient balance early-bail (line 74):** Not tested in this file. Likely covered elsewhere but not directly verified here.
4. **Auth/role/rate-limit preconditions:** Mocked away in this file. Covered by other test files.
5. **Pre-B2.2 regression test:** There is no test asserting the order of operations directly (e.g., asserting `updateMany` is called BEFORE `withdrawalRequest.create` via call-order inspection). The orphan-prevention test does this implicitly by asserting that `withdrawalRequest.create` is never called when `updateMany` returns count=0 — this IS the order-dependent invariant. So functionally, the order is tested.

**Sufficiency:** The 2 tests are **sufficient** to prove the orphan-prevention invariant. The minor gaps are about post-decrement failure modes (Steps 3-6 throwing), which would test recoverability rather than the orphan guarantee. The critical guarantee (no `WithdrawalRequest` without deduction) is directly and unambiguously tested by Test 1.

## Test Results

```
=== running test suite on feature/cloudflare-d1-validation ===

 Test Files  15 passed (15)
      Tests  348 passed (348)
   Start at  13:45:00
   Duration  10.35s

Passing test files include:
- tests/unit/wallets-withdraw.test.ts (2 tests) ← NEW B2.2 tests
- tests/unit/admin-status-validation.test.ts (11 tests)
- tests/unit/care-auth.test.ts (45 tests)
- tests/e2e/business-flow.test.ts (47 tests)
- tests/e2e/failure-scenarios.test.ts (28 tests)
- tests/security/bola-idor.test.ts (42 tests)
- ... (and 9 more files)
```

**Total: 348 / 348 passed, 0 failed.**

Pre-B2.2 baseline was 346/346 (per the B2.2 self-report and the B2.1-VERIFY count). B2.2 adds exactly 2 tests → 348/348. No regressions.

## TypeScript Results

```
$ bun run tsc --noEmit
# exit code 0, no output
```

**0 errors.** Matches B2.1's clean state — no new type errors introduced by the reorder or the new test file.

## ESLint Results

```
$ bunx eslint src/app/api/wallets/withdraw/route.ts tests/unit/wallets-withdraw.test.ts
(node:9338) ESLintIgnoreWarning: The ".eslintignore" file is no longer supported.
  Switch to using the "ignores" property in "eslint.config.js".
# exit code 0
```

**CLEAN.** The single warning is an unrelated, project-wide `.eslintignore` deprecation warning (pre-existing, not introduced by B2.2). No errors or warnings on the modified files themselves.

## Files Changed

```
$ git diff --stat 4f41eee..feature/cloudflare-d1-validation

 docs/BUNDLE_2_2_REPORT.md             | 205 +++++++++++++++++++++++++++++
 src/app/api/wallets/withdraw/route.ts |  82 ++++++------
 tests/unit/wallets-withdraw.test.ts   | 241 ++++++++++++++++++++++++++++++++++
 worklog.md                            |  39 ++++++
 4 files changed, 527 insertions(+), 40 deletions(-)

$ git diff --name-status 4f41eee..feature/cloudflare-d1-validation
A  docs/BUNDLE_2_2_REPORT.md
M  src/app/api/wallets/withdraw/route.ts
A  tests/unit/wallets-withdraw.test.ts
M  worklog.md
```

**Exactly 4 files changed — matches expectation:**

1. `src/app/api/wallets/withdraw/route.ts` — the fix (Modified, +42/-40)
2. `tests/unit/wallets-withdraw.test.ts` — new test file (Added, +241)
3. `docs/BUNDLE_2_2_REPORT.md` — B2.2 self-report (Added, +205)
4. `worklog.md` — worklog append (Modified, +39)

No spurious changes to other files (no `package.json`, no `prisma/schema.prisma`, no migrations, no unrelated source files). The fix is surgically scoped.

## SHA Verification

| Ref | Expected | Actual | Status |
|---|---|---|---|
| `feature/cloudflare-d1-validation` HEAD | `ccd7aa2…` | `ccd7aa254348ed01d6b363586b235bf8908cef6e` | ✅ |
| `feature/cloudflare-d1-validation` HEAD~1 (test commit) | `7b091ea…` | `7b091ea9822987e2bf114e1c72a76699c187ec9a` | ✅ |
| `feature/cloudflare-d1-validation` HEAD~2 (fix commit) | `895f604…` | `895f6044c2b0a0acf633a6ea92bc8e6c20ad11ed` | ✅ |
| `main` (local) | `625b23f…` (unchanged) | `625b23f66d5f459cd0b1824496468b7e2c194272` | ✅ unchanged |
| `new-repo/main` (remote) | `e4c2faf…` (unchanged) | `e4c2faf1447622da02bdd12a9535e367e8d46e36` | ✅ unchanged |
| `new-repo/feature/cloudflare-d1-validation` (remote) | `917b2b2…` (unchanged) | `917b2b2d2683a4360171e4b4602258586d1559e8` | ✅ unchanged (no push) |

All baseline SHAs match. No pushes occurred. main was not touched.

## Observations (non-blocking)

These are noted for completeness but do **not** affect the verdict:

1. **The B2.2 fix commit message and the B2.2 self-report both reference `docs/BUNDLE_2_1_VERIFY.md`, but that file is NOT present on `feature/cloudflare-d1-validation`** — it only exists on `main` (added in commit `625b23f`). The B2.2 author presumably read it via `git show main:docs/BUNDLE_2_1_VERIFY.md` or similar. This is a documentation cross-reference issue, not a code issue, and doesn't affect B2.2's correctness. (The B2.1 verify report lives on `main` because that's where the B2.1-VERIFY agent committed its findings — B2.2-VERIFY takes the same approach of writing its report on `feature/cloudflare-d1-validation` per the instructions.)

2. **The post-decrement failure paths (Steps 3-6 throwing) are not explicitly tested.** As analyzed in "Edge case analysis" above, these remain recoverable (deduction-without-payout, admin reconciles) and do NOT reintroduce the orphan-WithdrawalRequest vulnerability. Tests for these would be a nice-to-have for the next bundle.

3. **The fix deliberately does not wrap the writes in `db.$transaction`** because D1 doesn't expose `db.batch()` through Prisma yet. This is documented in the B2.2 self-report and is consistent with the established B2.1 pattern (SEC-8, SEC-9, SEC-10 all use sequential writes). Acceptable for D1 compatibility; a future migration to `db.batch()` (when Prisma supports it) would obsolete this pattern.

## Conclusion & Recommendation

**Verdict: APPROVED.**

The B2.2 fix correctly resolves the orphaned-WithdrawalRequest consistency hole flagged by B2.1-VERIFY:

- **Reorder is correct:** `wallet.updateMany` (atomic decrement, line 82) happens BEFORE `withdrawalRequest.create` (line 100). The `if (deductResult.count === 0) throw` guard at lines 86-89 sits BETWEEN them, ensuring no `WithdrawalRequest` is created when the atomic decrement fails.
- **Orphan-prevention invariant is proven:** There is no code path where `withdrawalRequest.create` executes without `wallet.updateMany` having returned `count === 1`. Edge case analysis confirms that even if Steps 3-6 fail, the failure is recoverable (deduction-without-payout — admin reconciles) rather than unrecoverable (payout-without-deduction).
- **Tests are real and sufficient:** Test 1 directly verifies the orphan-prevention invariant (`withdrawalRequest.create` NOT called when `updateMany` returns count=0). Test 2 verifies the happy path and the `actualBalanceAfter` correctness check. Both tests pass.
- **No regressions:** 348/348 tests pass (was 346/346 pre-B2.2, +2 new). TypeScript: 0 errors. ESLint: clean.
- **Surgical scope:** Only 4 files changed (fix + test + report + worklog). No spurious modifications to other files.
- **Branch hygiene:** main (local + remote) and remote feature all unchanged. No push, no merge, no force-push.

The Bundle 2.2 work is complete and correct. The orphaned-WithdrawalRequest issue identified by B2.1-VERIFY is resolved. Recommended follow-ups (carried forward):
1. Backfill concurrent-race tests for OTP verify (SEC-10) and wallet auto-release (SEC-8) — currently proven by code inspection only.
2. Enable branch protection on `main` (Phase-3 SEC-1, HIGH).
3. Consider adopting D1 `db.batch()` (if/when Prisma exposes it) to wrap multi-step wallet mutations in a true atomic batch.
4. (B2.2-specific) Optionally add tests for the post-decrement failure paths (Steps 3-6 throwing) to lock in the recoverability semantics.
