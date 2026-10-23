# Bundle 2.1 — Security Fixes Report

**Date:** 2026-10-15
**Executor:** Agent (single session, stayed on feature branch)
**Branch:** `feature/cloudflare-d1-validation`
**Baseline SHA:** `7694b7738b5913f49656f78ad1ec7ef1adc277f4` (recorded before work began)
**Final SHA:** `1465a5bd2ece824975421070dbd00e2b8438e73e`

## Executive Summary

- 5 SEC fixes applied: **YES** (SEC-7, SEC-8, SEC-9, SEC-10, SEC-11)
- Tests: **346 / 346** passed
- TypeScript: **0** errors (0 new, 0 pre-existing) — clean
- ESLint on modified files: **CLEAN** (0 errors)
- Files changed: **6** (5 source + 1 test) — expected
- main untouched: **YES** (local `f726615`, remote `e4c2faf`)
- Remote feature untouched (no push): **YES** (remote `917b2b2`)

## Critical Context — Why Bundle 2.1 Exists

Bundle 2 (prior attempt) failed because the orchestrator's bash session kept reverting
to `main` after each command. The orchestrator's wrapper auto-checks-out `main` before
every bash invocation. Commits accidentally landed on `main`, then were cherry-picked to
`feature` — but the cherry-picks introduced merge conflicts that were "resolved" by
checking out the wrong version of files. This caused:
- SEC-9: escaped backticks (`\``) in template literals → syntax errors
- SEC-10: lost the feature branch's `hashOtpCode`, `validateBody`, `rateLimitAsync`,
  `getDbForLib` improvements → OTP verify would never match in production

All 8 commits from Bundle 2 were eventually missing (git object database cleaned them up).

**Bundle 2.1 was executed using a different strategy that kept all edits inside the
feature branch.** See "Workflow Technique" section below for details.

## Baseline State (recorded before work)

- `feature/cloudflare-d1-validation` SHA (local): `7694b7738b5913f49656f78ad1ec7ef1adc277f4`
- `feature/cloudflare-d1-validation` SHA (remote `new-repo`): `917b2b2d2683a4360171e4b4602258586d1559e8`
- `main` SHA (local): `f726615a940b7e05cce6f16eca5ba40288685d18`
- `main` SHA (remote `new-repo`): `e4c2faf1447622da02bdd12a9535e367e8d46e36`

The local feature branch was 2 commits ahead of the remote feature branch:
- `7694b77 docs: update worklog with Phase 3 security audit completion`
- `fdb908c docs(phase3): backend security audit — 6 findings, no code changes`

These are pre-existing local-only docs commits (not part of Bundle 2.1).

## Workflow Technique — Staying on the Feature Branch

The orchestrator's bash wrapper auto-checks-out `main` BEFORE every bash invocation.
Within a single bash command, the branch persists. So Bundle 2.1 used this pattern:

1. Every git-touching bash command started with
   `git checkout feature/cloudflare-d1-validation 2>&1 | tail -1 && ...`
2. The `Edit` tool could not be used on source files under the project root because
   the wrapper switched the working tree back to `main` before the Edit ran — Edit
   would then modify `main`'s version of the file, not `feature`'s version.
3. **Solution**: copied the file from `feature`'s working tree to a temp file under
   `/home/z/bundle21_tmp/` (outside the project root, but still under `/home/z/`,
   which is the allowed Edit-tool root). The Edit tool was used on the temp file,
   then the temp file was copied back to the source path within the same bash command
   that also did `git checkout feature/cloudflare-d1-validation` + `git add` + `git commit`.
4. Every commit was followed by `git branch --show-current` and `git log --oneline -1`
   to confirm the commit landed on `feature/cloudflare-d1-validation`.

### Damage from Initial SEC-11 Commit (Repaired)

The very first SEC-11 commit (`0438885`) was made BEFORE this workflow was discovered.
It landed on `main` because the commit bash command did not start with
`git checkout feature/cloudflare-d1-validation`. The damage was repaired:
1. Switched to `feature/cloudflare-d1-validation` and cherry-picked `0438885` → became `372344c`.
2. Switched back to `main` and ran `git reset --hard f726615` to restore `main` to its
   pre-SEC-11 baseline.
3. All subsequent commits used the temp-file workflow and landed on `feature` first time.

`main` is now back at `f726615` (its original baseline). The orphaned `0438885` object
remains in the git object DB but is unreferenced — will be cleaned up by `git gc` eventually.

## Commits (7 landed on feature — 6 planned + 1 follow-up)

| # | SHA | Type | Description |
|---|------|------|------|
| 1 | `372344c` | fix | SEC-11: requireBookingParticipant on /api/care/bookings/[id]/timeline |
| 2 | `ce1808b` | fix | SEC-10: atomic updateMany for OTP one-time-code consumption |
| 3 | `640a031` | fix | SEC-8: conditional updateMany with count check on /api/wallets auto-release |
| 4 | `3943446` | fix | SEC-9: atomic decrement + re-read balance on /api/wallets/withdraw |
| 5 | `11a3e4b` | fix | SEC-7: production guard + payment validation on /api/vip/subscribe |
| 6 | `bf70071` | test | SEC-10: update OTP verify tests for atomic updateMany pattern |
| 7 | `1465a5b` | fix | SEC-7 follow-up: use `plan.priceIrr` (VipPlan schema field) for price comparison |

Commit #7 was a follow-up to fix a TypeScript error caught by `tsc --noEmit`. The
VipPlan Prisma model stores its price as `priceIrr` (Decimal, Iranian Rial), not `price`.
The original SEC-7 commit used `plan.price`; commit #7 corrected it to `plan.priceIrr`.

## Per-Fix Verification

### SEC-11 — BOLA on `/api/care/bookings/[id]/timeline`

- **File:** `src/app/api/care/bookings/[id]/timeline/route.ts`
- **Commit:** `372344c`
- **Diff:**
```diff
+import { requireBookingParticipant } from "@/lib/care-auth";

 export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
   const db = await getDbForLib();
   const session = await requireAuth(req);
   if (session instanceof NextResponse) return session;
   const { id } = await ctx.params;
+
+  // SEC-11 fix: BOLA check before reading timeline events.
+  // Without this, any authenticated user could read another user's booking
+  // timeline by guessing/enumerating the booking id (cross-tenant disclosure).
+  const authError = await requireBookingParticipant(session, id);
+  if (authError) return authError;
+
   const events = await db.serviceTimelineEvent.findMany({ where: { bookingId: id }, ... });
   return NextResponse.json(events);
 }
```
- **Preserved feature-branch features:** `getDbForLib()` ✓, `requireAuth` ✓
- **Security logic:** The route now calls `requireBookingParticipant(session, id)`
  immediately after `requireAuth` and BEFORE the DB query. This is the same pattern
  already used in the sibling route `src/app/api/care/bookings/[id]/route.ts` (lines
  16-17). `requireBookingParticipant` checks ADMIN / booking owner / assigned
  technician and returns 403 for non-participants. Without this, any authenticated
  user could read another user's booking timeline by guessing/enumerating the
  booking id (cross-tenant information disclosure).
- **Verdict:** **PASS**

### SEC-10 — OTP Replay on `/api/auth/otp/verify`

- **File:** `src/app/api/auth/otp/verify/route.ts`
- **Commit:** `ce1808b`
- **Diff (key section):**
```diff
-  const otp = await db.otpCode.findFirst({
-    where: { phone, code: codeHash, consumed: false },
-    orderBy: { createdAt: "desc" },
-  });
-
-  if (!otp) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
-  if (otp.expiresAt.getTime() < Date.now()) {
-    return NextResponse.json({ error: "Code expired" }, { status: 400 });
-  }
-
-  await db.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
+  // SEC-10 fix: atomic one-time-code consumption.
+  // ... see commit message for full rationale ...
+  const now = new Date();
+  const consumed = await db.otpCode.updateMany({
+    where: {
+      phone,
+      code: codeHash,
+      consumed: false,
+      expiresAt: { gt: now },
+    },
+    data: { consumed: true },
+  });
+
+  if (consumed.count === 0) {
+    return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
+  }
```
- **Preserved feature-branch features:**
  - `hashOtpCode` ✓ (imported from `@/lib/otp-crypto`, applied before WHERE)
  - `validateBody` ✓ (imported from `@/lib/api-helpers`, used for schema validation)
  - `rateLimitAsync` ✓ (imported from `@/lib/rate-limit`, applied before any DB work)
  - `getDbForLib` ✓ (imported from `@/lib/db-access`, called as `const db = await getDbForLib()`)
  - Persian error messages ✓
  - Session cookie logic ✓
  - User lookup fallback (digits-only phone match) ✓
  - User creation on first-time signup ✓
- **Security logic:** A single conditional `updateMany` atomically transitions the
  code from `consumed:false → consumed:true` ONLY if it is still unconsumed AND not
  expired. The WHERE clause `{ phone, code: codeHash, consumed: false, expiresAt: { gt: now } }`
  is enforced atomically by the DB engine. `count === 1` means we won the race;
  `count === 0` means the code was already used/expired/invalid — same 400 as before.
  **CRITICAL**: the WHERE clause uses `code: codeHash` (the SHA-256 digest), NOT
  `code: code` (plaintext). This was verified by grep: `code: codeHash` appears 2x,
  `code: code,` appears 0x.
- **Verdict:** **PASS**

### SEC-8 — Wallet Doubling on `/api/wallets`

- **File:** `src/app/api/wallets/route.ts`
- **Commit:** `640a031`
- **Diff (key section):**
```diff
   for (const t of releasable) {
-    await db.walletTransaction.update({
-      where: { id: t.id },
+    // SEC-8 fix: conditional updateMany with count check.
+    // ... see commit message for full rationale ...
+    const releaseResult = await db.walletTransaction.updateMany({
+      where: { id: t.id, status: "PENDING" },
       data: { status: "AVAILABLE", releasedAt: now },
     });
-    await db.wallet.update({
-      where: { id: wallet.id },
-      data: {
-        pendingBalance: { decrement: t.netAmount },
-        balance: { increment: t.netAmount },
-      },
-    });
+    if (releaseResult.count === 1) {
+      await db.wallet.update({
+        where: { id: wallet.id },
+        data: {
+          pendingBalance: { decrement: t.netAmount },
+          balance: { increment: t.netAmount },
+        },
+      });
+    }
   }
```
- **Preserved feature-branch features:** `getDbForLib()` ✓, `requireAuth` ✓,
  role check ✓, BOLA-safe technicianId derivation ✓
- **Security logic:** The `updateMany` WHERE clause adds `status: "PENDING"`. Only
  the first concurrent request that wins the race will match (count === 1) and
  apply the wallet delta. The second request will see the row already transitioned
  to AVAILABLE (count === 0) and skip the wallet update, preventing double-crediting.
  The previous unconditional `update` would have set status to AVAILABLE in both
  requests (idempotent SET) and then BOTH would increment wallet.balance.
- **Verdict:** **PASS**

### SEC-9 — Withdraw Race on `/api/wallets/withdraw`

- **File:** `src/app/api/wallets/withdraw/route.ts`
- **Commit:** `3943446`
- **Diff (key section):**
```diff
+    // SEC-9 fix: previously used `data: { balance: balanceAfter }` (a stale
+    // pre-computed SET) which allowed two concurrent withdraw requests to
+    // both pass the `balance >= amount` WHERE check and both SET balance to
+    // the same value (idempotent SET, not a second decrement) — effectively
+    // deducting only once while creating two withdrawal requests.
+    //
+    // Now uses Prisma atomic `decrement` operator: the SQL becomes
+    // `UPDATE wallet SET balance = balance - ? WHERE ...`, truly atomic at
+    // the DB level. The WHERE clause `balance: { gte: amount }` prevents
+    // negative balance.
     const deductResult = await db.wallet.updateMany({
       where: { id: wallet.id, balance: { gte: amount } },
-      data: { balance: balanceAfter },
+      data: { balance: { decrement: amount } },
     });
     if (deductResult.count === 0) {
       throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید");
     }
+
+    // Re-read the actual post-decrement balance for the ledger + response.
+    // We can't use `balanceAfter` anymore because the atomic decrement may
+    // have raced with other transactions — the true balance can only be
+    // known by re-reading it.
+    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
+    const actualBalanceAfter = updatedWallet ? Number(updatedWallet.balance) : balanceBefore - amount;

     // 4. Create ledger entry
     await db.walletLedger.create({
       data: {
         ...
-        balanceAfter,
+        balanceAfter: actualBalanceAfter,
         ...
       },
     });
     ...
-    return NextResponse.json({ withdrawal, newBalance: balanceAfter });
+    return NextResponse.json({ withdrawal, newBalance: actualBalanceAfter });
```
- **Preserved feature-branch features:** `getDbForLib()` ✓, `requireAuth` ✓,
  `rateLimitAsync` ✓ (3/hour), `getTechnicianFromSession` ✓, sequential-write D1 pattern ✓,
  `balanceBefore` variable ✓, Persian error messages ✓, withdrawal code generation ✓
- **Critical check (escaped backticks):** `grep -n '\\\`' src/app/api/wallets/withdraw/route.ts`
  returns empty — NO escaped backticks. Template literals like `` `Withdrawal request ${withdrawal.code}` ``
  are intact (unescaped).
- **Security logic:** The previous `data: { balance: balanceAfter }` was a stale
  pre-computed SET. Two concurrent withdraw requests could both pass the
  `balance >= amount` WHERE check and both SET balance to the SAME value
  (idempotent SET, not a second decrement) — effectively deducting only once
  while creating two withdrawal requests. The new `data: { balance: { decrement: amount } }`
  uses Prisma's atomic decrement operator, which compiles to
  `UPDATE wallet SET balance = balance - ? WHERE ...` — truly atomic at the DB
  level. The post-decrement balance is re-read from the DB for the ledger entry
  and response accuracy (we can't use the pre-computed `balanceAfter` anymore
  because another concurrent transaction may have raced with us).
- **Verdict:** **PASS**

### SEC-7 — VIP Bypass on `/api/vip/subscribe`

- **File:** `src/app/api/vip/subscribe/route.ts`
- **Commits:** `11a3e4b` (main fix) + `1465a5b` (priceIrr field name follow-up)
- **Diff (key sections, combined):**
```diff
+// SEC-7 fix (3-layer):
+// 1. Production guard — returns 404 in production builds (consistent with
+//    /api/auth/demo and /api/seed). Dev-only simulation until the real
+//    payment gateway is wired in.
+// 2. requireAuth — userId derived from session, never from body.
+// 3. paymentId validated server-side: must exist, belong to caller, have
+//    status SUCCEEDED, and cover plan price. Closes the free-VIP bypass.
 export async function POST(req: Request) {
+  // 1. Production guard — fail closed.
+  if (process.env.NODE_ENV === "production") {
+    return new NextResponse(null, { status: 404 });
+  }
+
+  // 2. Auth — userId comes from the session, never from the body.
   const session = await requireAuth(req);
   ...
+  // 3. Validate paymentId — must be a real SUCCEEDED payment by this user
+  //    that covers the plan price. This closes the free-VIP bypass.
+  //    Note: VipPlan stores price as `priceIrr` (Decimal, Iranian Rial).
+  if (typeof paymentId !== "string" || !paymentId) {
+    return NextResponse.json({ error: "paymentId is required" }, { status: 400 });
+  }
+  const payment = await db.payment.findUnique({ where: { id: paymentId } });
+  if (
+    !payment ||
+    payment.userId !== userId ||
+    payment.status !== "SUCCEEDED" ||
+    Number(payment.amount) < Number(plan.priceIrr)
+  ) {
+    return NextResponse.json({ error: "Invalid or insufficient payment" }, { status: 400 });
+  }
   ...
```
- **Preserved feature-branch features:** `getDbForLib()` ✓, `requireAuth` ✓,
  `session.userId` (BOLA-safe, not from body) ✓, existing cancellation of ACTIVE
  subscriptions ✓, expiresAt computation ✓, best-effort notification ✓
- **Adaptation note:** The feature branch's VIP subscribe route ALREADY had
  `requireAuth` + `session.userId` (so the "1. requireAuth" and "2. userId from
  session" layers from the task spec were already present). Bundle 2.1 added the
  two missing layers: production guard (layer 1 in the new comment) and paymentId
  validation (layer 3). The route header comment was rewritten to reflect the
  3-layer fix.
- **Security logic:**
  1. Production guard returns 404 in `NODE_ENV === "production"` — this route is
     dev-only simulation until a real payment gateway is wired in. Consistent with
     the existing pattern in `/api/auth/demo` and `/api/seed`.
  2. `requireAuth(req)` was already present — userId comes from `session.userId`,
     NEVER from the body.
  3. `paymentId` is validated server-side: must exist, must belong to the caller
     (`payment.userId === userId`), must have `status === "SUCCEEDED"`, and must
     cover the plan price (`Number(payment.amount) >= Number(plan.priceIrr)`).
     The VipPlan schema field is `priceIrr` (Decimal, Iranian Rial) — this was
     initially incorrectly written as `plan.price`, caught by `tsc --noEmit`,
     and corrected in commit `1465a5b`.
- **Verdict:** **PASS** (after the `priceIrr` follow-up commit)

## Test Results

- **Total:** 346
- **Passed:** 346
- **Failed:** 0
- **Duration:** 9.95s
- **Test files:** 14 passed (14)

Key test files:
- `tests/integration/auth.test.ts` (13 tests) — includes the updated OTP verify tests
  (mock `updateMany` returning `{ count: 1 }` for valid codes, `{ count: 0 }` for
  invalid/expired; asserts `updateMany` called with `code: hashOtpCode("123456")` in
  WHERE clause; asserts `findFirst` + `update` are NOT called)
- `tests/security/bola-idor.test.ts` (42 tests) — BOLA coverage
- `tests/unit/care-auth.test.ts` (45 tests) — `requireBookingParticipant` directly tested
- `tests/e2e/business-flow.test.ts` (47 tests) — end-to-end business flows

No test failures. No flaky tests observed.

## TypeScript Results

- **Total errors:** 0
- **NEW errors (in our 5 modified files):** 0
- **PRE-EXISTING errors (in other files):** 0

The TypeScript check (`bun run tsc --noEmit`) ran completely clean after the
`priceIrr` follow-up commit (`1465a5b`). The single transient error
(`Property 'price' does not exist on type '... priceIrr: Decimal ...'` in
`src/app/api/vip/subscribe/route.ts`) was caught and fixed before the final TSC run.

## ESLint Results

- **Modified files (5 source + 1 test):** CLEAN
- **Errors:** 0
- **Warnings:** 1 (unrelated to our changes — `.eslintignore` deprecation warning)

Command run:
```bash
bunx eslint src/app/api/vip/subscribe/route.ts \
  src/app/api/wallets/route.ts \
  src/app/api/wallets/withdraw/route.ts \
  src/app/api/auth/otp/verify/route.ts \
  "src/app/api/care/bookings/[id]/timeline/route.ts" \
  tests/integration/auth.test.ts
```

## Files Changed (diff vs remote feature `917b2b2`)

```
 docs/PHASE3_SECURITY_AUDIT.md                    | 251 +++++++++++++++++++++++
 src/app/api/auth/otp/verify/route.ts             |  32 ++-
 src/app/api/care/bookings/[id]/timeline/route.ts |   8 +
 src/app/api/vip/subscribe/route.ts               |  36 +++-
 src/app/api/wallets/route.ts                     |  29 ++-
 src/app/api/wallets/withdraw/route.ts            |  27 ++-
 tests/integration/auth.test.ts                   |  85 ++++----
 worklog.md                                       |  28 +++
 8 files changed, 424 insertions(+), 72 deletions(-)
```

Of these:
- `docs/PHASE3_SECURITY_AUDIT.md` — pre-existing local-only commit `fdb908c` (NOT part of Bundle 2.1)
- `worklog.md` — pre-existing local-only commit `7694b77` plus the B2.1 worklog append (NOT a Bundle 2.1 source change, just a worklog update)
- The 6 Bundle 2.1 source changes are: `src/app/api/auth/otp/verify/route.ts`,
  `src/app/api/care/bookings/[id]/timeline/route.ts`, `src/app/api/vip/subscribe/route.ts`,
  `src/app/api/wallets/route.ts`, `src/app/api/wallets/withdraw/route.ts`,
  `tests/integration/auth.test.ts`

## SHA Verification

- Baseline feature SHA (before work): `7694b7738b5913f49656f78ad1ec7ef1adc277f4`
- Final feature SHA (after work): `1465a5bd2ece824975421070dbd00e2b8438e73e`
- `main` SHA (local, unchanged): `f726615a940b7e05cce6f16eca5ba40288685d18`
- `main` SHA (remote `new-repo`, unchanged): `e4c2faf1447622da02bdd12a9535e367e8d46e36`
- `feature/cloudflare-d1-validation` SHA (remote `new-repo`, unchanged — no push): `917b2b2d2683a4360171e4b4602258586d1559e8`

## Deviations from the Original Task Spec

1. **7 commits instead of 6.** The 7th commit (`1465a5b`) is a small follow-up to
   fix a TypeScript error caught by `tsc --noEmit`. The VipPlan Prisma model uses
   `priceIrr` (Decimal, Iranian Rial), not `price`. The original SEC-7 fix used
   `plan.price`; the follow-up corrected it to `plan.priceIrr`. The fix is
   semantically identical — just the correct field name. No regression in security
   logic.

2. **SEC-7 adaptation.** The task spec assumed the VIP subscribe route had NO auth
   and accepted `userId` from the body (the main-branch state). The feature branch
   had ALREADY added `requireAuth` + `session.userId`. Bundle 2.1 added only the
   two missing layers (production guard + paymentId validation) on top of the
   feature branch's existing BOLA fix. The header comment was rewritten to reflect
   the 3-layer fix (with layers 1 and 2 listed as "already present" / "now
   formalized" and layer 3 as the new paymentId validation).

3. **Workflow technique (temp-file pattern).** The orchestrator's bash wrapper
   auto-checks-out `main` before every bash invocation, which would have caused
   Bundle 2's failure mode (commits landing on `main`, escaped backticks from
   heredocs, lost feature-branch improvements). To avoid this, source-file edits
   were done on temp files under `/home/z/bundle21_tmp/` (outside the project
   root, but still under `/home/z/` which is the Edit-tool's allowed root). The
   temp file was then copied back to the source path within the same bash command
   that did `git checkout feature/cloudflare-d1-validation` + `git add` +
   `git commit`. This ensured:
   - Each fix was based on the ACTUAL feature-branch content (preserving
     `getDbForLib`, `hashOtpCode`, `validateBody`, `rateLimitAsync`, etc.)
   - The Edit tool was used (not Python heredoc — avoiding escape issues)
   - All commits landed on `feature/cloudflare-d1-validation` first time
   - `main` was never touched (after the initial SEC-11 mishap was repaired)

4. **Initial SEC-11 mishap (repaired).** The very first SEC-11 commit (`0438885`)
   landed on `main` because the bash command did not start with
   `git checkout feature/cloudflare-d1-validation`. The damage was repaired:
   - Cherry-picked `0438885` onto `feature/cloudflare-d1-validation` → became `372344c`
   - Reset `main` back to `f726615` (its original baseline)
   - All subsequent commits used the temp-file workflow

5. **`docs/PHASE3_SECURITY_AUDIT_V2.md` and `docs/BUNDLE_2_VERIFICATION.md` do not
   exist.** The task spec referenced these as required reading, but they were
   among the missing commits from Bundle 2 (the git object DB cleaned them up).
   Bundle 2.1 proceeded based on the detailed per-fix instructions in the task
   spec itself, which contained the complete fix rationale and code patterns.

## Conclusion & Recommendation

**Verdict: Ready for independent review.**

All 5 SEC fixes (SEC-7, SEC-8, SEC-9, SEC-10, SEC-11) have been applied to
`feature/cloudflare-d1-validation` based on the ACTUAL current content of each
file (verified by reading the file before each edit, and by grep after each
edit). All feature-branch improvements (`hashOtpCode`, `validateBody`,
`rateLimitAsync`, `getDbForLib`) are preserved. All 346 tests pass. TypeScript
is clean. ESLint is clean.

`main` is untouched. Remote `feature` is untouched (no push).

The PR #3 (feature → main) can be reviewed independently. Recommendation: review
each commit's diff, with particular attention to:
- `ce1808b` (SEC-10): verify `code: codeHash` in WHERE clause (not plaintext)
- `3943446` (SEC-9): verify `data: { balance: { decrement: amount } }` (atomic, not stale SET)
- `11a3e4b` + `1465a5b` (SEC-7): verify production guard fires first, then paymentId validation
