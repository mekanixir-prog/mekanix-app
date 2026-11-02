# Financial Unit Contract Audit

**Status:** Audit only — no monetary values, schema fields, or historical records are changed by this document.  
**Reviewed:** 2026-11-02  
**Scope:** Wallet, withdrawals, display formatting, invoices, payments, VIP pricing, and gateway adapter boundary.

## Executive finding

MEKANIX does not currently have one consistently enforced monetary unit across persistence, business logic, display formatting, and payout/provider boundaries.

The repository contains explicit, conflicting declarations:

| Area | Current declaration or behavior | Evidence |
|---|---|---|
| Wallet aggregates | `balance`, `pendingBalance`, `totalEarned`, `totalCommission`, and `totalWithdrawn` are documented as IRR | `prisma/schema.prisma`, `model Wallet` |
| Wallet transactions | `grossAmount`, `commissionAmount`, and `netAmount` are documented as IRR | `prisma/schema.prisma`, `model WalletTransaction` |
| Withdrawals | `WithdrawalRequest.amount` is documented as IRR | `prisma/schema.prisma`, `model WithdrawalRequest` |
| Withdrawal API (PR #73) | Amount is explicitly treated as USD-base units; minimum is 5 and maximum is 10,000, with cent precision | `src/app/api/wallets/withdraw/route.ts` on `fix/withdrawal-bank-validation` |
| Technician earnings UI | Minimum withdrawal is `5 USD`; it passes the same numeric amount to the API and displays wallet aggregates through `money()` | `src/components/mek/technician/earnings.tsx` |
| Display formatting | `fmtMoney(amount, "IRR")` multiplies the input by `USD_TO_IRR`; default fallback rate is 60,000 | `src/lib/format.ts` |
| Persian money helper | `useT().money(amount)` forces the IRR formatting path for Persian users | `src/lib/use-t.ts` |
| Invoice and payment | Currency defaults to IRR | `prisma/schema.prisma`, `model Invoice`, `model Payment` |
| VIP plan | `VipPlan.priceIrr` is documented as IRR; activation checks payment currency is IRR and compares payment amount to plan price | `prisma/schema.prisma`, `src/app/api/vip/subscribe/route.ts` on PR #67 |
| Payment gateway adapter | Provider adapter contract says amounts passed to providers are IRR | `src/lib/payment-provider.ts` on PR #66 |

These declarations cannot all describe the same stored number. For example, the withdrawal API treats `5` as five USD-base units, while the wallet schema describes the stored amount as five IRR. The display helper then multiplies a value formatted as IRR by the USD→IRR rate.

## Why this blocks a safe merge

A unit mismatch can cause:
- withdrawal thresholds and balances to be interpreted at radically different scales;
- an incorrect wallet debit or bank payout;
- incorrect invoice totals, tax, commission, and technician earnings;
- a VIP payment comparison against the wrong unit;
- a gateway request whose amount differs from the amount stored in the payment record;
- historical records becoming ambiguous after a schema or formatter change.

Passing CI does not prove monetary correctness. PR #73's current tests validate the chosen USD-base threshold and input precision, but they do not prove that the persisted wallet balance and the actual bank transfer use the same unit.

## Proposed target contract (requires product-owner approval)

For an Iran-first product, the recommended target is:

1. **Canonical persisted unit:** integer IRR for all wallet balances, wallet ledger entries, withdrawals, invoices, payments, and gateway attempts.
2. **UI display:** show Toman in Persian UI by explicit IRR-to-Toman conversion (10 IRR = 1 Toman); do not use an exchange-rate multiplier to format an amount already stored in IRR.
3. **Foreign-currency inputs:** if a price source or product plan is expressed in USD, convert it to IRR once at quote/checkout time using a recorded rate and timestamp. Persist the resulting IRR amount and the rate metadata used for the quote.
4. **Gateway boundary:** pass the exact IRR amount persisted on the payment attempt to the provider adapter; never recompute the amount during callback verification.
5. **Precision:** use integer minor units (IRR) or a rigorously defined Decimal policy; do not use floating-point arithmetic for persisted financial calculations.
6. **Withdrawal minimum/maximum:** define these limits in IRR or Toman explicitly in server validation and UI copy. Do not use a USD threshold against an IRR wallet balance.
7. **Auditability:** record original quote amount, canonical amount, source currency, conversion rate, rate timestamp, and gateway amount where conversion occurs.

This proposal is not an instruction to reinterpret existing data. Before migration, trace every wallet credit/debit and invoice creation path, inspect production/staging values and their origin, and write a reversible backfill plan with reconciliation totals. No historical amount should be multiplied or divided based only on the current schema comment.

## Required implementation sequence

### Phase A — Trace and classify all writers/readers
- Find every write to Wallet, WalletTransaction, WalletLedger, WithdrawalRequest, Invoice, Payment, and PaymentGatewayLog.
- For each write path, identify the source unit and whether conversion has already occurred.
- Find every UI/API read and label its expected unit.
- Reconcile default technician rates, service prices, VIP prices, taxes, commission, and withdrawal limits.
- Add tests with known IRR/Toman examples and boundary values.

### Phase B — Adopt the contract
- Approve the canonical unit and Toman display convention.
- Add explicit currency/unit metadata where necessary.
- Add conversion-rate provenance to quote/payment records.
- Update the gateway adapter request contract to accept only canonical IRR amounts.
- Update PR #73 to validate withdrawal limits in the canonical unit.

### Phase C — Migrate safely
- Snapshot and reconcile balances and ledger totals.
- Determine the unit of each existing record from its creation path; quarantine ambiguous records for manual review.
- Backfill in a transaction or controlled migration with before/after totals.
- Never perform a blind global multiplier/divider migration.
- Run SQLite and PostgreSQL migration tests, then staging reconciliation before production.

### Phase D — Release gates
- Add integration tests for: customer payment → verified gateway attempt → Payment → invoice/VIP fulfillment; wallet credit → escrow release → withdrawal request → admin payout.
- Assert amount and unit equality at every boundary.
- Block release if any record has an unknown unit or if wallet/ledger reconciliation differs.

## Current PR implications

- **PR #73:** do not merge until its USD-base withdrawal amount is reconciled with the wallet's persisted unit and the actual payout workflow.
- **PR #66:** adapter hardening is useful, but the provider's IRR contract must be enforced by the authoritative payment lifecycle, not just documented in the adapter.
- **PR #67:** VIP validation compares IRR payment and IRR plan price; preserve that equality when payment lifecycle is connected.
- **PR #68:** CARE extra proposal currently validates integer Toman amounts. Convert those to the canonical unit at a single documented boundary before adding them to an IRR invoice.

## Explicitly out of scope

No live SMS, payment credentials, domain, DNS, VPS, or production payout activation is required for this audit. Those remain launch-stage configuration, as planned. The simulator and staging lifecycle must nevertheless exercise the same amount and idempotency contract before launch.
