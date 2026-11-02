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


## Additional confirmed finding — seed data is not IRR

A follow-up inspection of `prisma/seed.ts` shows that the mismatch extends beyond formatting and withdrawals:

- Technician `travelFeeBase` is seeded as `3 + i * 0.5` and explicitly commented as USD, with an approximate IRR equivalent.
- `inspectionFee` is seeded as 7–11 and explicitly commented as USD.
- `inspectionFeeHeavy` is seeded as 20–35 and explicitly commented as USD.
- Wallet balances are seeded as small values (50, 75, 100, ...), without an IRR denomination; these are not realistic IRR wallet balances.
- VIP `priceIrr` values are seeded as 9, 19, and 39, which are not plausible rial prices and appear to be legacy USD-like values despite the field name.
- Service category `basePrice` values (70–220), part `unitPrice` values, labor rates, travel fees, and inspection fees feed invoice calculations. The resulting Invoice and Payment rows are nevertheless labelled `IRR`.
- Seeded payments use `currency: "IRR"` while deriving their amounts from the same small USD-like service/rate values.

This means that simply removing the USD-to-IRR display multiplier would make seeded and potentially existing records display as tiny rial amounts. Conversely, multiplying all such values by an exchange rate would be unsafe because the actual unit and provenance of every existing record is not established.

### Expanded migration blocker

**Do not merge a runtime-only formatter change or the current PR #73 withdrawal implementation.** Before changing production financial interpretation, classify every price source and every persisted financial row:

1. Distinguish seeded/demo data from real user data.
2. Establish the intended Iranian market price in IRR for hourly labor, inspection, travel, service category, parts, VIP, and withdrawals.
3. Trace every invoice and payment writer to prove the final amount is integer IRR before persistence.
4. Reconcile wallet aggregates against ledger entries and withdrawal records.
5. Add explicit IRR validation at API and database write boundaries.
6. Only then prepare a migration for records whose original unit can be proven; quarantine unknown records rather than guessing.

### Product pricing decision still needed

The IRR-only unit is settled. Actual business prices are not. The repository's existing small seed numbers must not be treated as approved Iranian market prices. Until the product owner supplies or approves a pricing schedule, use test fixtures clearly labelled as synthetic and do not enable real financial flows.


## Follow-up source trace — invoice, payment, VIP, CARE, and wallet

The following findings were confirmed by reading the current `main` source after the initial audit. They are documentation findings only; no runtime behavior has been changed by this audit PR.

### Invoice calculation has a separate legacy path

- `src/lib/pricing.ts` declares an IRR-only pricing engine, uses Decimal arithmetic, and rounds calculated monetary results to integer IRR.
- `src/app/api/invoices/route.ts` does **not** call that pricing engine. It calculates invoices directly from `Technician.hourlyRate`, `Part.unitPrice`, and `Technician.travelFeeBase`.
- That route uses JavaScript `number` arithmetic for labor, parts, travel, tax, and total, then persists the result with `currency: "IRR"`; no integer-IRR rounding/validation is performed there.
- The current seed writes technician hourly rates such as 52–90 and parts prices such as 340/28, while the invoice route labels the derived total IRR. These values must be reclassified before the invoice writer can be trusted.
- Required fix: route every invoice calculation through one approved pricing contract (or an explicitly shared integer-IRR calculation module), reject non-integer IRR results at the persistence boundary, and remove duplicate legacy pricing logic. Do not simply connect the current pricing engine until its approved rate schedule and input units are confirmed.

### Payment lifecycle is not live and still contains dollar semantics

- `src/app/api/payments/route.ts` is a development-only simulator: it returns 404 in production and randomly reports success 95% of the time in non-production.
- The simulated payment notification text still renders the invoice amount with a dollar sign (`${inv.total}`), despite the invoice currency field being IRR.
- `src/lib/payment-provider.ts` declares provider amounts as IRR, but `getPaymentProviderStatus()` explicitly reports `integrationWired: false`; the adapter is not connected to an authoritative initiate → persisted attempt → callback verification → payment/ledger lifecycle.
- The simulator's verification result returns amount 0. It must never be treated as a verified financial amount.
- Required fix: wire a persisted IRR payment attempt to the provider, verify against the exact stored integer IRR amount, compare provider-returned amount/currency where supported, and only then mark the invoice/payment fulfilled. Keep production fail-closed until this is complete.

### VIP subscription validation needs a currency equality check

- `src/app/api/vip/subscribe/route.ts` is also hidden in production pending real gateway integration.
- In development, it checks that the payment belongs to the user, has status `SUCCEEDED`, and that `payment.amount >= plan.priceIrr`; it does not explicitly require `payment.currency === "IRR"`, nor exact amount equality for the selected plan.
- Required fix: require IRR currency and an integer amount, bind the payment to the intended VIP plan/purpose, and validate the exact payable amount under the approved plan/proration rules. A generic payment that happens to be numerically large enough must not activate VIP.

### CARE extra proposals cross a Toman-labelled boundary without conversion

- `src/app/api/care/bookings/[id]/extra-proposal/route.ts` accepts `partPrice` and `laborPrice` from the request body and persists their arithmetic result directly.
- The customer notification labels that result as Toman. The handler does not validate safe integer Toman inputs, nor convert the amount to IRR before persisting it.
- Required fix: define the CARE proposal contract explicitly as integer Toman only if that is the intended technician-facing input; validate it, convert exactly once using `Toman × 10 = IRR` at the approved invoice/payment boundary, and test that no proposal amount is charged or credited before conversion. If the API contract is changed to IRR, update every client and label together instead.

### Wallet movement is atomic, but atomicity does not prove the unit

- The withdrawal helper and escrow-release helper use transactional Prisma operations or D1 batches to keep wallet aggregate changes, withdrawal/ledger records, and escrow status transitions consistent.
- These are useful integrity controls, but they currently move the numeric amount as supplied. They do not establish whether the amount represents IRR, USD-base units, or legacy demo values.
- Required fix: preserve the atomic operations while adding integer-IRR validation at their shared boundaries; reconcile `Wallet`, `WalletTransaction`, `WalletLedger`, and `WithdrawalRequest` before any historical data conversion.

### New release gates

1. Unify invoice creation with the approved integer-IRR pricing engine and prove that every source rate/part price is IRR.
2. Require `currency === "IRR"` and integer-safe amounts for VIP/payment fulfillment.
3. Keep payment and VIP production routes disabled until the provider lifecycle is integrated and verified end-to-end.
4. Make CARE's Toman input/output contract explicit and test the single conversion boundary.
5. Retain wallet atomicity, but add unit and integer validation before any debit, credit, release, or payout.
6. Add regression tests that fail on dollar symbols, USD-base thresholds, non-IRR currencies, fractional IRR, unconverted CARE Toman, or invoice calculations that bypass the canonical pricing module.


## Follow-up source trace — prepay, parts, and payout settlement

A second pass through the financial writers found additional enforcement gaps:

### Pre-service payment is the only confirmed wallet-credit path in the inspected job-payment flow

- `src/app/api/prepay/route.ts` derives inspection and travel fees from the technician profile and passes them to `recordPrepayAtomically`.
- The route is a development simulator and returns 404 in production. Its code comments say a non-empty card number is sufficient for the simulated card flow.
- `recordPrepayAtomically` correctly groups the job paid marker, PREPAY/COMMISSION transactions, ledger rows, and wallet aggregate updates in a Prisma transaction or D1 batch.
- However, the route calculates `commission = gross * 0.10` and `net = gross - commission` with JavaScript numbers and does not reject fractional, unsafe, negative, or otherwise invalid IRR amounts before the atomic writer.
- The seed inspection/travel values feeding this route are explicitly USD-like. Atomic writes therefore preserve consistency but can consistently persist the wrong monetary unit.
- Required fix: the server must resolve approved integer-IRR inspection/travel fees, use deterministic integer rounding for commission, validate all amounts before the atomic write, and keep the simulator inaccessible in production.

### Parts endpoint and invoice endpoint do not enforce integer IRR

- `src/app/api/jobs/[id]/parts/route.ts` accepts `unitPrice` as a JavaScript number and rejects only negative values. It does not require a safe integer or establish that the input is IRR.
- `src/app/api/invoices/route.ts` then multiplies those part values by quantity and calculates tax/total using floating-point numbers.
- Required fix: make the part API contract explicitly integer IRR, validate `Number.isSafeInteger`, and use the shared integer-safe pricing calculation for all invoice components.

### Invoice payment does not currently settle a technician wallet entry

- The inspected `src/app/api/payments/route.ts` marks the invoice/payment successful, completes the job, creates a warranty, and sends notifications.
- It does not create a `WalletTransaction`, `WalletLedger` entry, or technician wallet credit for the invoice total. The separate prepay flow does create wallet entries for inspection + travel only.
- This is an unresolved settlement-model question, not an assumed defect: confirm whether repair labor/parts invoice proceeds are intended to become technician earnings, and if so implement a separately auditable, idempotent settlement path with the platform commission and hold policy. Do not infer this from the existing prepay flow.

### Admin payout atomicity still lacks monetary-unit validation

- `src/lib/withdrawal-admin-atomic.ts` atomically handles approval, rejection/refund, and PAID status plus payout transaction/aggregate updates.
- It requires a bank transfer reference before marking a withdrawal PAID, which is a useful operational safeguard.
- It moves `WithdrawalRequest.amount` as-is and does not independently validate integer IRR. Unit and integer validation must be enforced before the admin transition as well as at request creation.

### Updated implementation checklist

1. Validate every external monetary input as a safe integer IRR at the API boundary (parts, prepay, invoice, gateway, withdrawal, and admin payout).
2. Move commission and tax calculations to deterministic integer arithmetic with explicitly documented rounding.
3. Reuse one canonical pricing function for both service estimates and invoice generation; do not let invoice generation bypass it.
4. Decide and document whether invoice proceeds (repair labor/parts) are technician earnings, distinct from prepay inspection/travel proceeds.
5. Keep all simulator-only routes production-blocked until the real provider lifecycle and reconciliation tests are complete.


### Pricing-engine constants are implementation defaults, not approved tariffs

The current `src/lib/pricing.ts` hardcodes a base labor rate of 50,000 IRR/hour, a base visit fee of 15,000 IRR, a distance rate of 2,000 IRR/km, a 1.5× emergency multiplier, and a 9% tax default. It fetches `ServicePackage.basePrice` but deliberately does not apply it to the calculation. These values demonstrate an IRR-shaped calculation path; they are **not evidence of an owner-approved MEKANIX price schedule**. They must be reviewed and approved before becoming live tariffs, and any configured tax rule must be reconciled with the applicable business/legal policy.


## Follow-up source trace — currency formatting, client checkout, and admin pricing

### Currency formatter and exchange-rate polling conflict with IRR-only storage

- `src/lib/constants.ts` exposes USD, EUR, and IRR as supported currencies, although the product requirement is IRR-only.
- `src/lib/format.ts` defaults unknown currencies to USD and multiplies values passed as `IRR` by a mutable USD→IRR rate. Its default fallback rate is 60,000.
- `src/lib/use-t.ts` fetches `/api/exchange-rate` on mount and every five minutes, then injects that rate into the formatter. For Persian users it forces the currency argument to IRR, which currently means an already-IRR amount is multiplied by an FX rate.
- Required fix: replace this with a pure integer-IRR formatter (no FX request, no rate state, no USD/EUR fallback). If Toman display is retained, calculate it only as a labelled presentation value from integer IRR; never change the stored/API amount.

### Technician withdrawal UI still asks for dollars

- `src/components/mek/technician/earnings.tsx` declares `MIN_WITHDRAWAL = 5 // USD`, validates the client input against it, inserts a dollar sign in the error text, and uses a `Min $5` input placeholder.
- The server route `src/app/api/wallets/withdraw/route.ts` has a different rule: any positive finite number up to 10,000 is accepted. It does not enforce the UI minimum and does not require an integer/safe integer.
- `src/lib/schemas/wallet.ts` repeats the 10,000 cap and positive-only validation, also without an integer or safe-integer constraint.
- Required fix: delete the USD-based UI threshold and dollar labels; set a single owner-approved IRR minimum/maximum policy shared by UI, Zod schema, and server route. Until those limits are approved, do not invent a replacement threshold. Regardless of threshold, require positive safe-integer IRR.

### Shared payment component carries a USD contract comment

- `src/components/mek/shared/payment-gateway.tsx` types its `amount` prop as a number with the comment `USD`, then renders the value using the shared money formatter.
- Required fix: make the component contract explicitly integer IRR and ensure the checkout request, provider adapter, verification response, and UI all refer to the same stored IRR amount. Keep it disabled until provider integration and amount verification are real.

### Admin CARE package price accepts unchecked values

- `src/app/api/care/admin/packages/route.ts` writes `body.basePrice` directly (or defaults it to zero) without visible validation for integer-IRR semantics.
- CARE booking creation uses the shared pricing engine, which reads package base price, so this admin input is a source of future customer-facing prices.
- Required fix: validate admin-entered package prices as non-negative safe integer IRR, and require a separately approved tariff before exposing the package as purchasable.

### Release blockers now explicitly include the presentation layer

1. Remove all USD/EUR currency options from MEKANIX product transaction paths and all USD-based labels/comments/limits.
2. Remove exchange-rate polling and the USD→IRR conversion from the shared formatter.
3. Enforce safe-integer IRR at every amount entry point, including technician withdrawal, admin package pricing, parts, prepay, invoice, and gateway.
4. Do not set a replacement withdrawal minimum/maximum until MEKANIX approves the actual IRR policy.
5. Add UI regression checks for no dollar symbol, no foreign-exchange dependency, and consistent IRR display across customer, technician, and admin surfaces.


## Cross-check of the open implementation PRs

This section records the state of the open branches reviewed on 2026-11-02. Passing CI is not a substitute for the IRR contract gates below.

- **PR #66 — payment provider adapters:** adds provider adapter tests and IDPay verification that compares the returned integer amount and order ID with the persisted request. The adapter module itself explicitly remains disabled from the live payment lifecycle; the real route/persistence/callback/fulfillment integration is still a separate blocker. The shared payment UI still documents its amount as USD on `main`.
- **PR #67 — VIP payment purpose:** improves the route by requiring `currency === "IRR"`, a verified gateway log, the VIP purpose, matching payment identity, and a matching gateway-log amount. However, the route still accepts `payment.amount >= plan.priceIrr` rather than exact plan-price equality, and it does not explicitly require the payment and plan amounts to be safe integer IRR. It remains production-disabled until the gateway lifecycle is wired.
- **PR #72 — CARE extra proposal atomicity:** adds safe-integer validation for part and labor prices, but explicitly defines those values as Toman. The proposal total remains in Toman; this PR does not convert the amount to IRR or establish a single invoice/payment boundary. Its Zod schema also permits fractional prices even though the custom validator rejects them, so the route must consistently use the strict validator.
- **PR #73 — bank withdrawal validation:** improves bank destination validation and atomic payout handling, but explicitly preserves USD-base amounts, a $5 minimum, a $10,000 maximum, and cent precision. It is incompatible with IRR-only money and remains release-blocked.
- **PR #74 — financial audit:** documentation only; its CI, PostgreSQL CI, Docker E2E, and Production Readiness workflows passed on the preceding documented commit. The latest documentation commit has a new workflow run in progress at the time of this update.

### Additional required gates from PR review

1. For VIP, require `Number.isSafeInteger(payment.amount)`, integer IRR plan price, and the approved exact-price/discount policy. Do not silently accept overpayment unless an explicit credit/refund rule exists.
2. For CARE, choose one boundary: keep technician proposal input in integer Toman and convert exactly once to integer IRR before invoice/payment persistence, or migrate all clients/API labels to integer IRR. The current atomicity PR alone does not make this decision.
3. Align the CARE Zod schema and strict custom validator so fractional money cannot pass through an alternate call path.
4. Keep PR #73 out of the release path until its USD-base contract is replaced by an approved IRR policy and integer-safe amount validation.
5. Keep PR #66 adapter work separate from live payment activation until an authoritative persisted attempt, callback verification, and idempotent fulfillment path is complete.


### Gateway initiation branch still trusts the client amount (simulator only)

- In PR #66, `src/app/api/gateway/initiate/route.ts` explicitly documents that the amount comes from the client for development testing and that production must resolve it from the linked invoice/plan. It is currently production-guarded and returns 404 in production.
- The development route checks only positive/truthy amount and a 100,000,000 IRR ceiling; it does not require `Number.isSafeInteger`. It then stores the client amount with `currency: "IRR"`.
- The paired verify route is also simulator-only. It creates a successful Payment from the stored gateway-log amount and uses a unique `gatewayLogId` for retry safety, but it is not a real provider callback/signature-verification flow.
- Required fix before production: derive the payable amount server-side from the linked invoice or VIP plan, validate it as a safe integer IRR, persist purpose/entity linkage, and verify the real provider callback against that exact amount and currency. Never accept the amount from the browser as the source of truth.

### CARE strict validator status clarification

- The PR #72 route does call `validateExtraProposalInput`, which rejects fractional and unsafe integer Toman values before the atomic write. The separate Zod `extraProposalSchema` still permits fractional price values, so the two validation contracts can drift; consolidate them or add tests proving every route uses the strict integer validator.
- The atomic writer persists the validated numeric amounts without converting them. The route's notification labels the calculated total as Toman. No conversion to IRR occurs in the proposal path itself.
