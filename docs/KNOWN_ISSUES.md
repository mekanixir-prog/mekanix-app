# MEKANIX — Known Issues & Limitations

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`

## Issue Format

Each issue has: ID, Severity, Status, Description, Affected Files, Mitigation

## Severity Levels

- **Critical** — Blocks production release
- **High** — Must be resolved before release
- **Medium** — Should be resolved, workaround exists
- **Low** — Nice to fix, not blocking

---

## KI-001: Multi-step writes without atomicity

- **Severity:** Medium
- **Status:** Documented (not fixable without D1 transactions)
- **Description:** Multiple database writes (e.g., payment.create → invoice.update → job.update → warranty.create → notification.create) are sequential `await` calls without transaction wrapping. If step N fails, steps 1..N-1 persist.
- **Affected Files:** `payments/route.ts`, `prepay/route.ts`, `wallets/withdraw/route.ts`, `invoices/route.ts`, `care/bookings/route.ts`, `care/bookings/[id]/approve-extra/route.ts`, `care/bookings/[id]/extra-proposal/route.ts`, `care/bookings/[id]/reject-extra/route.ts`, `care/bookings/[id]/findings/route.ts`, `care/bookings/[id]/inspection/route.ts`, `care/bookings/[id]/health-report/route.ts`, `care/technician/missions/[id]/route.ts`
- **Root Cause:** D1 does not support Prisma `$transaction`
- **Mitigation:** Non-critical steps (notification, message, warranty) use `.catch()` to prevent crashes. Critical steps (payment, invoice, job status) use optimistic concurrency (`updateMany` with `where` conditions).
- **Close Condition:** D1 adds transaction support, or application-level compensation pattern is implemented.

## KI-002: Payment gateway is simulator-only

- **Severity:** High (for production)
- **Status:** Guarded — returns 404 in production
- **Description:** `gateway/initiate` and `gateway/verify` accept any non-empty OTP (4+ chars) as success. No real bank verification.
- **Affected Files:** `gateway/initiate/route.ts`, `gateway/verify/route.ts`
- **Mitigation:** Production guard returns 404. Real Zarinpal/IDPay integration required before enabling.
- **Close Condition:** Real payment gateway integrated and tested.

## KI-003: SMS provider is console-only

- **Severity:** High (for production)
- **Status:** Expected — `SMS_PROVIDER=console` in wrangler.toml
- **Description:** OTP codes are logged to console, not sent via SMS.
- **Mitigation:** Configure real provider (Kavenegar/MeliPayamak/FaraPayamak) via env vars.
- **Close Condition:** Real SMS provider configured and tested.

## KI-004: 34 files still use sync `db`

- **Severity:** High (for Workers deployment)
- **Status:** In Progress
- **Description:** 34 files (9 lib + 25 routes, 136 db calls) still import `{ db } from "@/lib/db"`. In Workers runtime, these routes will throw "sync `db.X` not supported" errors.
- **Affected Files:** See `docs/d1-migration-inventory.json` (files with `"migrated": false`)
- **Mitigation:** None — these routes must be migrated before Workers deployment.
- **Close Condition:** All 34 files migrated to `getDbForLib()`.

## KI-005: Invoice duplicate creation returns 500

- **Severity:** Low
- **Status:** Pre-existing (not introduced by migration)
- **Description:** `invoices/route.ts` POST creates invoice via `db.invoice.create()`. The `Invoice` model has `@unique jobId`, so Prisma throws on duplicate. The caller gets HTTP 500 instead of 409 Conflict.
- **Affected Files:** `invoices/route.ts`
- **Mitigation:** Caller should check if invoice exists before creating.
- **Close Condition:** Add pre-check or catch P2002 error and return 409.

## KI-006: Wallet ledger may be missing after withdrawal

- **Severity:** Medium
- **Status:** Documented
- **Description:** In `wallets/withdraw/route.ts`, if `walletLedger.create` fails after `wallet.updateMany` succeeds, the balance is correctly deducted but the ledger entry is missing (audit gap).
- **Affected Files:** `wallets/withdraw/route.ts`
- **Mitigation:** The `.catch()` on the outer try block returns an error to the client, but the withdrawal + deduction persist. A reconciliation job should verify ledger completeness.
- **Close Condition:** Application-level compensation or reconciliation pattern implemented.

## KI-007: `$transaction` in comments only

- **Severity:** Low
- **Status:** Resolved (inventory corrected)
- **Description:** 10 files have `uses_transaction: true` in inventory, but ALL are in comments (e.g., "D1 has no $transaction"). Zero actual `$transaction` calls in code.
- **Affected Files:** 10 care + jobs + wallets files
- **Mitigation:** Inventory regenerated from actual code with comment-vs-code distinction.
- **Close Condition:** N/A — documentation accuracy issue, now corrected.

## KI-008: admin-panel is a separate project

- **Severity:** Low
- **Status:** Pending decision
- **Description:** `admin-panel/` has its own `package.json`, `tsconfig.json`, and `prisma/schema.prisma`. But 4 route files exist in `src/app/api/admin-panel/` that import from `@/lib/db`. Migration scope for these is unclear.
- **Affected Files:** `src/app/api/admin-panel/auth/login/route.ts`, `src/app/api/admin-panel/auth/me/route.ts`, `src/app/api/admin-panel/onboarding/[id]/route.ts`, `src/app/api/admin-panel/onboarding/route.ts`
- **Mitigation:** These routes are excluded from TypeScript check via `tsconfig.json` exclude.
- **Close Condition:** Decision made: migrate to `getDbForLib()`, remove from main project, or keep excluded.
