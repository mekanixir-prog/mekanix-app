# Financial Unit Contract Audit

**Status:** Product-owner decision recorded — IRR is the only permitted monetary unit. Implementation and historical-data reconciliation remain pending.  
**Reviewed:** 2026-11-02  
**Scope:** Wallet, withdrawals, display formatting, invoices, payments, VIP pricing, CARE pricing, and gateway adapter boundary.

## Binding product decision

MEKANIX uses **Iranian rial (IRR) exclusively** as its monetary unit throughout the product.

- USD and other foreign currencies must not be used as wallet units, accounting units, invoice currencies, payment currencies, withdrawal units, gateway amounts, plan prices, service prices, or internal calculation units.
- Persist all monetary amounts as integer IRR. Do not store fractional rial and do not use floating-point arithmetic for financial calculations.
- Bank payouts and gateway requests must be denominated in IRR and match the persisted IRR amount exactly.
- Persian UI may optionally show a clearly labelled Toman equivalent, calculated only as `IRR / 10`. Toman is a display convention only; it is never the persistence or API unit.
- No exchange-rate endpoint, live FX rate, fallback USD/IRR rate, or hidden currency conversion may affect MEKANIX monetary values.
- Foreign-currency amounts received from an external source are not valid MEKANIX transaction amounts. They must not enter the payment, wallet, invoice, pricing, or payout flow.

This is a binding product requirement, not a proposal awaiting approval.

## Executive finding

The repository currently violates this requirement in multiple places. The conflicts are not cosmetic: the code contains a USD-base withdrawal threshold, a USD-to-IRR display multiplier, and an exchange-rate fetch used by the Persian money helper.

| Area | Current declaration or behavior | Required state |
|---|---|---|
| Wallet aggregates | `balance`, `pendingBalance`, `totalEarned`, `totalCommission`, and `totalWithdrawn` documented as IRR | Integer IRR only |
| Wallet transactions | `grossAmount`, `commissionAmount`, and `netAmount` documented as IRR | Integer IRR only |
| Withdrawals | `WithdrawalRequest.amount` documented as IRR | Integer IRR only; limits explicitly defined in IRR |
| Withdrawal API (PR #73) | Amount treated as USD-base units; minimum 5, maximum 10,000, cent precision | Remove USD semantics and decimal precision; validate integer IRR |
| Technician earnings UI | Minimum withdrawal is `5 USD`; amount passed unchanged to API | Show and submit integer IRR; no dollar labels |
| Display formatting | `fmtMoney(amount, "IRR")` multiplies input by `USD_TO_IRR`; fallback rate 60,000 | Format an already-IRR amount without FX multiplication |
| Persian money helper | `useT().money(amount)` forces IRR formatting, while `useT()` fetches a live USD→IRR rate | No FX fetch; money helper treats input as IRR |
| Invoice and payment | Currency defaults to IRR | Enforce IRR on every write and provider boundary |
| VIP plan | `VipPlan.priceIrr` documented as IRR; activation compares IRR payment and plan price | Preserve integer-IRR equality |
| CARE extra proposal | Prices currently described as integer Toman | Convert once at the CARE-to-invoice boundary using `Toman × 10 = IRR`; API/storage contract must be explicit |
| Payment gateway adapter | Provider contract says amounts passed to providers are IRR | Enforce integer IRR from persisted payment attempt through verification |

## Why this blocks a safe merge

A unit mismatch can cause:
- withdrawal thresholds and balances to be interpreted at radically different scales;
- an incorrect wallet debit or bank payout;
- incorrect invoice totals, tax, commission, and technician earnings;
- a VIP payment comparison against the wrong unit;
- a gateway request whose amount differs from the amount stored in the payment record;
- historical records becoming ambiguous after a schema or formatter change.

Passing CI does not prove monetary correctness. PR #73's current USD-base threshold and cent precision conflict with the product's IRR-only requirement. The current formatter also multiplies amounts already labelled IRR by a live or fallback USD→IRR rate.

## Required target contract

1. **Canonical persisted unit:** integer IRR for all wallet balances, wallet ledger entries, withdrawals, invoices, payments, service prices, CARE prices after boundary conversion, VIP prices, taxes, commissions, and gateway attempts.
2. **API contract:** all monetary request and response fields are integer IRR. Document field units in schemas and API types; reject non-integer, negative, unsafe, or out-of-range values where inappropriate.
3. **UI display:** format canonical IRR directly. If the product chooses to display Toman, derive it explicitly by dividing by 10 and label it Toman. Never use an exchange-rate multiplier.
4. **No FX dependency:** remove the exchange-rate polling and USD/foreign-currency conversion path from monetary formatting and transaction flows.
5. **Gateway boundary:** pass the exact integer IRR amount persisted on the payment attempt to the provider adapter; callback verification must compare against that same persisted IRR amount.
6. **Precision:** use integer IRR arithmetic or a rigorously defined integer-safe calculation policy. Do not use JavaScript floating-point arithmetic for persisted financial calculations. Tax, percentage commission, and proportional allocations must define deterministic rounding in IRR.
7. **Withdrawal limits:** define minimum and maximum as explicit integer IRR constants in the server contract and mirror the same values in UI copy. Do not use a USD threshold or fractional precision.
8. **Auditability:** record the source and calculation breakdown for an amount where useful, but every resulting payable/receivable amount remains IRR. Foreign-currency conversion is not part of MEKANIX's internal financial contract.

## Required implementation sequence

### Phase A — Trace and classify all writers/readers
- Find every write to Wallet, WalletTransaction, WalletLedger, WithdrawalRequest, Invoice, Payment, PaymentGatewayLog, VipPlan, and service/Care pricing.
- For each write path, identify the source unit and any Toman-to-IRR conversion.
- Find every UI/API read and label its expected unit.
- Reconcile technician rates, service prices, VIP prices, taxes, commission, and withdrawal limits.
- Add tests with known IRR/Toman examples and integer boundary values.
- Search for USD, dollar symbols, exchange-rate helpers, and foreign currency defaults in all app code, tests, seed data, docs, and environment configuration.

### Phase B — Enforce the IRR-only contract
- Remove `USD_TO_IRR`, `setUsdToIrrRate`, `getUsdToIrrRate`, and the exchange-rate fetch from money formatting and Persian UI initialization.
- Make `fmtMoney` format canonical IRR directly; remove USD as the fallback currency.
- Update PR #73 withdrawal validation and UI to integer IRR with explicit IRR minimum/maximum.
- Ensure the payment lifecycle, invoice, VIP, CARE and provider adapter use integer IRR.
- Convert Toman-originated CARE inputs only at one explicit, tested boundary (`Toman × 10`).
- Remove dollar symbols, USD minimum labels, cent precision, and any live FX dependency from MEKANIX transaction flows.

### Phase C — Migrate safely
- Snapshot and reconcile balances and ledger totals.
- Determine the actual unit of each existing record from its creation path; quarantine ambiguous records for manual review.
- Backfill only records whose unit is proven. Use a reversible migration with before/after totals.
- Never perform a blind global multiplier/divider migration.
- Run SQLite and PostgreSQL migration tests, then staging reconciliation before production.

### Phase D — Release gates
- Add integration tests for: customer payment → verified gateway attempt → Payment → invoice/VIP fulfillment; wallet credit → escrow release → withdrawal request → admin payout.
- Assert integer IRR amount equality at every boundary.
- Block release if any record has an unknown unit or if wallet/ledger reconciliation differs.
- Verify no USD currency or FX conversion remains in production transaction paths.

## Current PR implications

- **PR #73:** do not merge until the USD-base withdrawal amount, USD threshold, and decimal precision are replaced with integer IRR semantics and the actual bank payout contract is verified.
- **PR #66:** enforce the provider's IRR contract end-to-end from persisted payment attempt through verification.
- **PR #67:** preserve integer-IRR equality between VIP plan price and successful payment.
- **PR #68:** CARE proposal amounts currently described as Toman must be converted once to IRR before they enter an IRR invoice; document and test that boundary.
- **PR #74:** records the product decision and audit gates; it does not itself change runtime behavior.

## Explicitly out of scope

No live SMS, payment credentials, domain, DNS, VPS, or production payout activation is required now. Those remain launch-stage configuration, as planned. The simulator and staging lifecycle must nevertheless exercise the same IRR-only amount and idempotency contract before launch.
