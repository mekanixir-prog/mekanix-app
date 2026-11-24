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


---

## Current verified status overlay — 2026-11-24

This section supersedes the historical status labels above where they conflict. The original entries are retained for audit history; do not use their 2026-10-11 status labels as current release evidence.

| ID | Current status | Current evidence / release impact |
|---|---|---|
| KI-001 | **Partially mitigated — Medium** | Critical financial flows now use Prisma transactions or D1 transactional batches with row-count assertions (prepay, withdrawals, wallet release, gateway verification, CARE booking and extra-proposal decisions, job status). Remaining sequential CARE writes are tracked in Issue #235: findings, inspection, health report and mission timeline updates. |
| KI-002 | **Open — High / production blocker** | Payment simulator paths remain disabled in production. Zarinpal/IDPay adapter contract tests are sandbox-mocked only; the complete real-provider attempt → callback → verification → ledger/outbox lifecycle is not activated or evidenced. See Issue #24. |
| KI-003 | **Open — High / production blocker** | The current production config still uses the console SMS provider. CI verifies production OTP fails closed without a real provider; it does not prove real SMS delivery. |
| KI-004 | **Resolved for production route consumers** | The old 34-file/7-file inventory is stale. Current route code uses `getDbForLib()`; the only code-search hit for a direct `@/lib/db` import was a stale comment in `src/lib/db.worker.ts`, corrected in this candidate. The separate `admin-panel/` package remains a separate project scope (KI-008). |
| KI-005 | **Resolved** | Invoice creation now returns an existing invoice on idempotent retry and resolves the unique `Invoice.jobId` race by re-reading the winner instead of returning a duplicate-create 500. |
| KI-006 | **Resolved for withdrawal debit/request/ledger** | Withdrawal creation and admin approve/reject/paid transitions now use Prisma transactions or D1 batches and validate the linked ledger evidence. Keep the separate production bank-transfer/reconciliation gates open. |
| KI-007 | **Resolved** | The transaction inventory distinguishes actual calls from comments. |
| KI-008 | **Partially resolved / architecture decision pending** | Main-app `src/app/api/admin-panel/*` routes inspected in this candidate use `getDbForLib()`. The standalone `admin-panel/` directory remains excluded from the main TypeScript project and still needs an explicit keep/migrate/remove decision. |
| KI-009 | **Open — Medium** | Legacy mechanic-application phone values are not guaranteed to be normalized before raw-column uniqueness is enforced; SQLite/PostgreSQL canonicalization differs. Tracked in Issue #234. |
| KI-010 | **Open — Medium** | CARE finding/inspection/health-report and mission state writes can commit without their timeline event if a later D1 statement fails. Tracked in Issue #235. |

### Additional release gates — still NO-GO

- Controlled staging/production financial provenance inventory and independent reconciliation approval. Synthetic CI fixtures prove SQL compatibility, not the state of real records. See Issue #81.
- Real payment-provider sandbox lifecycle, webhook/callback authenticity, replay/concurrency, refunds and reconciliation. See Issue #24.
- Real SMS provider configuration and successful delivery/expiry/rate-limit evidence.
- Production wallet escrow Worker is now configured with a guarded deployment script and 15-minute Cron, but it has **not** been deployed or observed. Until deployment is separately approved and two Cron cycles are verified, matured production escrow may remain `PENDING`.
- Remote D1 staging migration, backup/restore and rollback evidence. PostgreSQL CI backup/restore rehearsal is isolated test evidence only.
- Independent human review and approval of the exact final PR #186 SHA.
- Explicit owner Go/No-Go for the exact final SHA.

**No production D1 migration, production Worker deployment, real SMS/payment activation, payout, PR merge to `main`, or public launch is authorized by this status overlay.**
