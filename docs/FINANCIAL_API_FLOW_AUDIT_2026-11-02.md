# MEKANIX — Financial API Flow Audit
**Date:** 2026-11-02  
**Reviewed baseline:** `main` at `4e701370d674cdcde40cabba3e360703b249c029`  
**Related documents:** `FINANCIAL_UNIT_CONTRACT_AUDIT_2026-11-02.md`, `FINANCIAL_DATA_PROVENANCE_INVENTORY_2026-11-02.md`

> Source-level review only. No production database was queried. Findings describe code paths, not the currency of historical rows. No runtime code or data was changed.

## 1. Executive summary

The API layer has useful server-authoritative and atomicity protections, but those protections do not establish a consistent monetary unit.

The highest-risk boundaries are:
1. Invoice creation: derives amounts from technician/part records, then labels the invoice IRR without proving that its source values are IRR.
2. CARE extra proposals: accepts client-supplied part/labor prices and persists a derived total without strict money validation or an explicit unit boundary.
3. Prepay: derives fees from technician profile fields with conflicting seed/schema currency provenance, then calculates a 10% commission using JavaScript numbers.
4. Withdrawal: uses an atomic balance decrement and idempotency, but the main route accepts any finite positive number up to 10,000; it does not enforce safe integer IRR.
5. VIP subscription: verifies that a successful payment covers the plan price, but uses `payment.amount >= plan.priceIrr` and does not verify the payment currency or exact amount.
6. Pricing engine: uses Decimal.js, but does not validate money inputs as nonnegative safe integer IRR or validate rounded outputs against the safe-integer boundary.

Payment and prepay simulator routes are production-guarded in the reviewed source. This is a useful safety barrier, not evidence that real payment integration is complete.

## 2. API flow matrix

| Flow | Input/source of amount | Validation / calculation | Persisted records | Unit conclusion |
|---|---|---|---|---|
| Invoice create `POST /api/invoices` | Technician `hourlyRate`, `travelFeeBase`; job parts `unitPrice × quantity`; optional `laborHours` | Client money ignored; labor hours clamped 0–100. Money arithmetic uses JS `number`; tax rate comes from platform setting or 9%; no safe-integer validation. | Invoice totals and `currency: "IRR"` | **Not proven IRR.** Upstream technician/part data has ambiguous or conflicting provenance. |
| Invoice edit `PATCH /api/invoices/[id]` | No monetary input allowed | Allow-list blocks amount and currency edits; notes and restricted status changes only | Invoice metadata/status | **Good boundary:** amount edits are blocked here. |
| Payment `POST /api/payments` | `invoice.total` from DB, not request amount | Simulator has random success; production returns 404; payment copies invoice currency | Payment, invoice status, job completion, warranty | **Amount source is server-side**, but payment inherits any incorrect invoice amount/unit. |
| Gateway initiate / verify | Initiate accepts a request amount; verify uses persisted gateway log amount | Existing gateway implementation reviewed separately in the prior audit; simulator/dev guard and callback authenticity remain release blockers | PaymentGatewayLog and Payment | Do not enable until server-side invoice/plan amount binding, provider verification, exact IRR and integer checks are complete. |
| VIP subscribe `POST /api/vip/subscribe` | Plan `priceIrr`; payment record | Requires caller-owned SUCCEEDED payment, but checks `Number(payment.amount) < Number(plan.priceIrr)`; no currency equality, exact amount, or safe-integer check in this route | UserVipSubscription | **Insufficient.** Overpayment accepted; a non-IRR payment record could qualify unless upstream invariant is enforced. Route is production-guarded. |
| CARE extra proposal `POST /api/care/bookings/[id]/extra-proposal` | Client `partPrice`, `quantity`, `laborPrice` | Uses truthy fallbacks and JS multiplication/addition; no type, finite, nonnegative, safe-integer, or currency validation in this route | CustomerApproval partPrice/laborPrice/totalPrice; notification labels amount Toman | **Known Toman-facing boundary.** Needs a strict Toman input schema and one explicit conversion to IRR before any invoice/payment use. |
| CARE approval `POST /api/care/bookings/[id]/approve-extra` | Reads existing CustomerApproval | Changes approval and booking state; does not revalidate money values | CustomerApproval status and timeline | Approval is not a financial validation step. Must not treat approval as proof of valid IRR amount. |
| Parts `POST /api/jobs/[id]/parts` | Client `unitPrice`, `quantity` | Rejects negative price and nonpositive quantity only when number; fractional prices are accepted; quantity is floored; no finite/safe-integer/currency validation | Part.unitPrice and quantity | **Ambiguous.** Money must be validated as integer IRR at this boundary once unit contract is declared. |
| Prepay `POST /api/prepay` | Technician inspection fee + travel fee | Server derives from technician profile; commission = gross × 0.10 using JS number; no safe-integer/unit check; simulator-only and production-guarded | Job fee/commission/net fields, WalletTransaction, WalletLedger, Wallet aggregates | **High risk.** Technician fee source conflicts with USD-labelled seed values and IRR schema comments. |
| Wallet read / auto-release `GET /api/wallets` | Existing WalletTransaction.netAmount | Atomic release helper moves pendingBalance to balance; validates state and sufficient pending balance, not monetary unit or integer-IRR semantics | Wallet balances and transaction status | Atomicity is good; it cannot repair or prove source units. |
| Withdrawal `POST /api/wallets/withdraw` | Client `amount` | Finite, positive, <= 10,000; idempotency and atomic balance check exist; no safe-integer or explicit unit contract | WithdrawalRequest, wallet balance, ledger via atomic helper | **Not ready for IRR-only contract.** Do not guess intended limit or multiply values. |
| Admin CARE package `POST /api/care/admin/packages` | Client `basePrice` | Writes `body.basePrice || 0`; no type, finite, nonnegative, safe-integer, or currency validation | ServicePackage.basePrice | **Unspecified unit.** Package amount is currently informational in pricing engine; do not treat as active approved tariff. |
| Pricing engine `calculatePrice` | Caller `partsCost`, `laborHours`, `travelDistanceKm`, optional VIP discount | Decimal.js arithmetic and integer rounding; no input validation for partsCost safe integer/nonnegative; no output safe-integer check; hardcoded defaults include 50,000 IRR/hour, 15,000 IRR visit, 2,000 IRR/km, 9% tax and 1.5 emergency multiplier | PricingBreakdown / PricingSnapshot currency IRR | Intended IRR path, but defaults are implementation values, not owner-approved prices or tax policy. |

## 3. Detailed findings

### API-FLOW-01 — Invoice unit is inherited from ambiguous source records

File: `src/app/api/invoices/route.ts`

- The route correctly ignores client-supplied money values.
- It loads technician rates and job part rows from the database.
- It calculates labor, parts, travel, subtotal, tax, and total using JavaScript `number`.
- It stores `currency: "IRR"` without checking that the technician and part values were entered as IRR.
- The technician and part fields have conflicting or undocumented seed provenance (see the data provenance inventory).
- Notification and message strings print the amount without a consistent explicit unit formatter.

**Required later:** centralize invoice pricing through a validated IRR pricing service, validate source records, and add safe-integer checks before persistence. Do not simply replace the formula with current pricing-engine defaults; commercial values are not approved.

### API-FLOW-02 — CARE proposal is an unvalidated Toman boundary

File: `src/app/api/care/bookings/[id]/extra-proposal/route.ts`

- The endpoint trusts `body.partPrice`, `body.quantity`, and `body.laborPrice` for monetary calculation.
- It uses `|| 0` and JavaScript arithmetic, so malformed, fractional, negative, string, or unsafe values are not rejected consistently at this route.
- It persists the amounts to Decimal columns without a currency field.
- The customer notification explicitly appends the Toman label.
- The related approval endpoint changes workflow status but does not validate the amounts again.

**Required later:** define a Zod contract with safe integer Toman values if that is the retained public contract; reject all ambiguous input shapes. Convert once at a named CARE-to-invoice adapter (`Toman × 10 = IRR`) and persist/use IRR after that boundary. Add tests proving there is no second conversion.

### CARE follow-up PR review — validation and atomicity do not yet complete the IRR boundary

The following open Draft PRs were reviewed after the baseline audit. They are not merged into `main`, so the findings above continue to describe the reviewed main-branch behavior until those changes are integrated.

- **PR #68** adds strict validation for CARE proposal prices as nonnegative safe-integer **Toman** amounts, quantity 1–100, and a safe computed total. This closes the malformed/fractional/unsafe-input gap on its branch; it does not convert Toman to IRR.
- **PR #72** depends on PR #68 and makes proposal creation atomic across the Prisma transaction and D1 batch paths. Its proposal writer still persists the validated Toman values directly into `CustomerApproval` Decimal fields, which have no currency marker. Its notification still labels the amount as Toman.
- The main-branch customer approve/reject routes remain separate sequential writes. Approval changes workflow state; it does not normalize or revalidate proposal money. The customer detail UI renders proposal amounts through the shared `money()` helper, so its unit assumptions must be verified together with the formatter before changing the persisted unit.

**Safe conclusion:** do not add a one-way Toman × 10 conversion only to the proposal writer. First trace and update the full CARE lifecycle (proposal persistence, detail API/UI, approval/rejection, invoice/payment handoff, notifications, and tests) so every consumer agrees that persisted values are IRR. Existing rows must remain untouched until their provenance is classified. Keep PR #72 dependent on #68 and do not merge either as a substitute for the IRR boundary work.

### API-FLOW-03 — Prepay combines ambiguous technician rates and floating commission arithmetic

File: `src/app/api/prepay/route.ts`

- Fee values are derived from technician inspection and travel fields rather than client-supplied amounts.
- Those technician fields have explicit USD-labelled seed values despite IRR schema comments.
- `commission = gross * 0.10` and `net = gross - commission` use JS floating-point arithmetic.
- The atomic writer preserves a consistent multi-record update but does not validate the amount unit or integer-IRR invariant.
- The route is simulator-only and returns 404 in production.

**Required later:** resolve technician fee provenance and contract; validate gross/commission/net as integer IRR; select and document a commission rounding rule only after owner approval. Do not silently adopt half-up or any other business rounding policy.

### API-FLOW-04 — VIP payment coverage is not exact

File: `src/app/api/vip/subscribe/route.ts`

- Payment ownership and SUCCEEDED status are checked.
- It accepts a payment when `payment.amount >= plan.priceIrr`.
- It does not compare `payment.currency` to IRR or require exact equality.
- It converts Decimal values to JS numbers for comparison.
- The route is production-guarded pending real gateway integration.

**Required later:** bind the payment to the specific plan/purpose and server-calculated amount; require exact integer IRR and exact amount/currency match. Keep this blocked until gateway lifecycle and replay/race controls are verified.

### API-FLOW-05 — Parts API accepts fractional/ambiguous monetary values

File: `src/app/api/jobs/[id]/parts/route.ts`

- Negative unit prices are rejected only if the supplied value is a number.
- Fractional prices and non-finite edge cases are not explicitly rejected.
- Quantity is floored when a number, while money is stored as Decimal.
- The route has no declared currency field or explicit IRR contract.

**Required later:** strict request schema; integer IRR unit price; bounded positive integer quantity; reject string coercion and unsafe integers.

### API-FLOW-06 — Withdrawal amount is bounded but not unit-safe

File: `src/app/api/wallets/withdraw/route.ts`

- It requires a finite positive numeric amount and caps it at 10,000.
- Idempotency and atomic balance decrement are present.
- It does not require `Number.isSafeInteger(amount)`.
- The route does not explicitly state whether request amount is IRR or another unit.
- A separate PR #73 contains USD-base withdrawal thresholds; that policy is not compatible with the IRR-only contract.

**Required later:** make the API unit explicit and IRR-only; require safe integer IRR. Do not set min/max limits until the owner approves them. Resolve or supersede the conflicting PR #73 policy before enabling withdrawals.

### API-FLOW-07 — Pricing engine rounds but does not validate IRR inputs/outputs

File: `src/lib/pricing.ts`

- Decimal.js avoids ordinary binary floating-point composition errors.
- Money fields such as `partsCost` are not validated as safe nonnegative integer IRR.
- Rounded Decimal values are converted to JS number without checking `Number.isSafeInteger`.
- The default labor, travel, tax, emergency and vehicle multipliers are implementation defaults, not approved business terms.
- The package base price is fetched but intentionally unused.

**Required later:** validate money inputs and outputs with the IRR money core; retain decimal precision for hours and distance where those are measurements, not money. Do not change business defaults without approval.

### API-FLOW-08 — Atomic wallet helpers guarantee consistency, not currency correctness

Files: `src/lib/prepay-atomic.ts`, `src/lib/wallet-release.ts`, `src/lib/withdrawal-atomic.ts`

- Atomicity, idempotency, balance guards and rollback protections are valuable.
- These helpers receive numbers and persist Decimal values.
- They do not establish whether those numbers are IRR, integers, nonnegative, or derived from a verified source.
- A perfectly atomic transaction can still atomically persist an incorrect unit.

**Required later:** validate at public API boundaries and again at the shared financial writer boundary. Preserve existing atomic behavior and add unit/integer tests.

### CARE lifecycle trace — proposal display, approval, invoice and payment

A follow-up source trace was completed against `main` at the reviewed baseline. It confirms several additional gaps that must be addressed together rather than by changing only the proposal endpoint.

1. **Persistence has no unit field.** `CustomerApproval.partPrice`, `laborPrice`, and `totalPrice` are Decimal columns with no currency/unit marker. PR #68 validates incoming prices as integer Toman on its branch; PR #72 makes proposal creation atomic but does not convert those stored values to IRR.
2. **Customer display has an explicit unit mismatch.** `src/components/mek/customer/care-detail.tsx` renders `partPrice × quantity`, `laborPrice`, and `totalPrice` through `useT().money()`. The current shared formatter `src/lib/format.ts` multiplies every amount passed with currency `IRR` by the live `USD_TO_IRR` rate. `useT()` defaults its money helper to `IRR` for both languages and explicitly forces `IRR` for Persian. Consequently the display is not a safe Toman display and is not a correct integer-IRR display either. This formatter issue affects other IRR screens too; it must be fixed centrally with explicit unit-aware formatters, not patched only in CARE.
3. **Approval is workflow-only, not a financial handoff.** `approve-extra` loads the approval, checks ownership and state, then changes approval/finding/booking statuses and writes a timeline event. It does not validate or normalize the money fields, create an invoice, create a payment, or attach the proposal to the separate `Job/Invoice` flow. The inspected `reject-extra` route similarly changes workflow state and has no financial handoff.
4. **Approval/rejection writes are sequential.** Both routes document that D1 writes are sequential; a failure after the first write can leave partially updated approval/finding/booking/timeline state. PR #72 addresses atomicity for proposal creation only, not customer approval/rejection. Add a separate cross-adapter atomic state-transition fix before treating the CARE lifecycle as transaction-safe.
5. **Invoice/payment is a separate legacy flow.** `POST /api/invoices` creates a `Job` invoice from technician rates and `Part` rows, then labels it IRR without source-unit proof. `POST /api/payments` copies that invoice amount/currency, but the route is a random-success simulator and returns 404 in production. Its technician notification still prefixes the amount with `# MEKANIX — Financial API Flow Audit
**Date:** 2026-11-02  
**Reviewed baseline:** `main` at `4e701370d674cdcde40cabba3e360703b249c029`  
**Related documents:** `FINANCIAL_UNIT_CONTRACT_AUDIT_2026-11-02.md`, `FINANCIAL_DATA_PROVENANCE_INVENTORY_2026-11-02.md`

> Source-level review only. No production database was queried. Findings describe code paths, not the currency of historical rows. No runtime code or data was changed.

## 1. Executive summary

The API layer has useful server-authoritative and atomicity protections, but those protections do not establish a consistent monetary unit.

The highest-risk boundaries are:
1. Invoice creation: derives amounts from technician/part records, then labels the invoice IRR without proving that its source values are IRR.
2. CARE extra proposals: accepts client-supplied part/labor prices and persists a derived total without strict money validation or an explicit unit boundary.
3. Prepay: derives fees from technician profile fields with conflicting seed/schema currency provenance, then calculates a 10% commission using JavaScript numbers.
4. Withdrawal: uses an atomic balance decrement and idempotency, but the main route accepts any finite positive number up to 10,000; it does not enforce safe integer IRR.
5. VIP subscription: verifies that a successful payment covers the plan price, but uses `payment.amount >= plan.priceIrr` and does not verify the payment currency or exact amount.
6. Pricing engine: uses Decimal.js, but does not validate money inputs as nonnegative safe integer IRR or validate rounded outputs against the safe-integer boundary.

Payment and prepay simulator routes are production-guarded in the reviewed source. This is a useful safety barrier, not evidence that real payment integration is complete.

## 2. API flow matrix

| Flow | Input/source of amount | Validation / calculation | Persisted records | Unit conclusion |
|---|---|---|---|---|
| Invoice create `POST /api/invoices` | Technician `hourlyRate`, `travelFeeBase`; job parts `unitPrice × quantity`; optional `laborHours` | Client money ignored; labor hours clamped 0–100. Money arithmetic uses JS `number`; tax rate comes from platform setting or 9%; no safe-integer validation. | Invoice totals and `currency: "IRR"` | **Not proven IRR.** Upstream technician/part data has ambiguous or conflicting provenance. |
| Invoice edit `PATCH /api/invoices/[id]` | No monetary input allowed | Allow-list blocks amount and currency edits; notes and restricted status changes only | Invoice metadata/status | **Good boundary:** amount edits are blocked here. |
| Payment `POST /api/payments` | `invoice.total` from DB, not request amount | Simulator has random success; production returns 404; payment copies invoice currency | Payment, invoice status, job completion, warranty | **Amount source is server-side**, but payment inherits any incorrect invoice amount/unit. |
| Gateway initiate / verify | Initiate accepts a request amount; verify uses persisted gateway log amount | Existing gateway implementation reviewed separately in the prior audit; simulator/dev guard and callback authenticity remain release blockers | PaymentGatewayLog and Payment | Do not enable until server-side invoice/plan amount binding, provider verification, exact IRR and integer checks are complete. |
| VIP subscribe `POST /api/vip/subscribe` | Plan `priceIrr`; payment record | Requires caller-owned SUCCEEDED payment, but checks `Number(payment.amount) < Number(plan.priceIrr)`; no currency equality, exact amount, or safe-integer check in this route | UserVipSubscription | **Insufficient.** Overpayment accepted; a non-IRR payment record could qualify unless upstream invariant is enforced. Route is production-guarded. |
| CARE extra proposal `POST /api/care/bookings/[id]/extra-proposal` | Client `partPrice`, `quantity`, `laborPrice` | Uses truthy fallbacks and JS multiplication/addition; no type, finite, nonnegative, safe-integer, or currency validation in this route | CustomerApproval partPrice/laborPrice/totalPrice; notification labels amount Toman | **Known Toman-facing boundary.** Needs a strict Toman input schema and one explicit conversion to IRR before any invoice/payment use. |
| CARE approval `POST /api/care/bookings/[id]/approve-extra` | Reads existing CustomerApproval | Changes approval and booking state; does not revalidate money values | CustomerApproval status and timeline | Approval is not a financial validation step. Must not treat approval as proof of valid IRR amount. |
| Parts `POST /api/jobs/[id]/parts` | Client `unitPrice`, `quantity` | Rejects negative price and nonpositive quantity only when number; fractional prices are accepted; quantity is floored; no finite/safe-integer/currency validation | Part.unitPrice and quantity | **Ambiguous.** Money must be validated as integer IRR at this boundary once unit contract is declared. |
| Prepay `POST /api/prepay` | Technician inspection fee + travel fee | Server derives from technician profile; commission = gross × 0.10 using JS number; no safe-integer/unit check; simulator-only and production-guarded | Job fee/commission/net fields, WalletTransaction, WalletLedger, Wallet aggregates | **High risk.** Technician fee source conflicts with USD-labelled seed values and IRR schema comments. |
| Wallet read / auto-release `GET /api/wallets` | Existing WalletTransaction.netAmount | Atomic release helper moves pendingBalance to balance; validates state and sufficient pending balance, not monetary unit or integer-IRR semantics | Wallet balances and transaction status | Atomicity is good; it cannot repair or prove source units. |
| Withdrawal `POST /api/wallets/withdraw` | Client `amount` | Finite, positive, <= 10,000; idempotency and atomic balance check exist; no safe-integer or explicit unit contract | WithdrawalRequest, wallet balance, ledger via atomic helper | **Not ready for IRR-only contract.** Do not guess intended limit or multiply values. |
| Admin CARE package `POST /api/care/admin/packages` | Client `basePrice` | Writes `body.basePrice || 0`; no type, finite, nonnegative, safe-integer, or currency validation | ServicePackage.basePrice | **Unspecified unit.** Package amount is currently informational in pricing engine; do not treat as active approved tariff. |
| Pricing engine `calculatePrice` | Caller `partsCost`, `laborHours`, `travelDistanceKm`, optional VIP discount | Decimal.js arithmetic and integer rounding; no input validation for partsCost safe integer/nonnegative; no output safe-integer check; hardcoded defaults include 50,000 IRR/hour, 15,000 IRR visit, 2,000 IRR/km, 9% tax and 1.5 emergency multiplier | PricingBreakdown / PricingSnapshot currency IRR | Intended IRR path, but defaults are implementation values, not owner-approved prices or tax policy. |

## 3. Detailed findings

### API-FLOW-01 — Invoice unit is inherited from ambiguous source records

File: `src/app/api/invoices/route.ts`

- The route correctly ignores client-supplied money values.
- It loads technician rates and job part rows from the database.
- It calculates labor, parts, travel, subtotal, tax, and total using JavaScript `number`.
- It stores `currency: "IRR"` without checking that the technician and part values were entered as IRR.
- The technician and part fields have conflicting or undocumented seed provenance (see the data provenance inventory).
- Notification and message strings print the amount without a consistent explicit unit formatter.

**Required later:** centralize invoice pricing through a validated IRR pricing service, validate source records, and add safe-integer checks before persistence. Do not simply replace the formula with current pricing-engine defaults; commercial values are not approved.

### API-FLOW-02 — CARE proposal is an unvalidated Toman boundary

File: `src/app/api/care/bookings/[id]/extra-proposal/route.ts`

- The endpoint trusts `body.partPrice`, `body.quantity`, and `body.laborPrice` for monetary calculation.
- It uses `|| 0` and JavaScript arithmetic, so malformed, fractional, negative, string, or unsafe values are not rejected consistently at this route.
- It persists the amounts to Decimal columns without a currency field.
- The customer notification explicitly appends the Toman label.
- The related approval endpoint changes workflow status but does not validate the amounts again.

**Required later:** define a Zod contract with safe integer Toman values if that is the retained public contract; reject all ambiguous input shapes. Convert once at a named CARE-to-invoice adapter (`Toman × 10 = IRR`) and persist/use IRR after that boundary. Add tests proving there is no second conversion.

### CARE follow-up PR review — validation and atomicity do not yet complete the IRR boundary

The following open Draft PRs were reviewed after the baseline audit. They are not merged into `main`, so the findings above continue to describe the reviewed main-branch behavior until those changes are integrated.

- **PR #68** adds strict validation for CARE proposal prices as nonnegative safe-integer **Toman** amounts, quantity 1–100, and a safe computed total. This closes the malformed/fractional/unsafe-input gap on its branch; it does not convert Toman to IRR.
- **PR #72** depends on PR #68 and makes proposal creation atomic across the Prisma transaction and D1 batch paths. Its proposal writer still persists the validated Toman values directly into `CustomerApproval` Decimal fields, which have no currency marker. Its notification still labels the amount as Toman.
- The main-branch customer approve/reject routes remain separate sequential writes. Approval changes workflow state; it does not normalize or revalidate proposal money. The customer detail UI renders proposal amounts through the shared `money()` helper, so its unit assumptions must be verified together with the formatter before changing the persisted unit.

**Safe conclusion:** do not add a one-way Toman × 10 conversion only to the proposal writer. First trace and update the full CARE lifecycle (proposal persistence, detail API/UI, approval/rejection, invoice/payment handoff, notifications, and tests) so every consumer agrees that persisted values are IRR. Existing rows must remain untouched until their provenance is classified. Keep PR #72 dependent on #68 and do not merge either as a substitute for the IRR boundary work.

### API-FLOW-03 — Prepay combines ambiguous technician rates and floating commission arithmetic

File: `src/app/api/prepay/route.ts`

- Fee values are derived from technician inspection and travel fields rather than client-supplied amounts.
- Those technician fields have explicit USD-labelled seed values despite IRR schema comments.
- `commission = gross * 0.10` and `net = gross - commission` use JS floating-point arithmetic.
- The atomic writer preserves a consistent multi-record update but does not validate the amount unit or integer-IRR invariant.
- The route is simulator-only and returns 404 in production.

**Required later:** resolve technician fee provenance and contract; validate gross/commission/net as integer IRR; select and document a commission rounding rule only after owner approval. Do not silently adopt half-up or any other business rounding policy.

### API-FLOW-04 — VIP payment coverage is not exact

File: `src/app/api/vip/subscribe/route.ts`

- Payment ownership and SUCCEEDED status are checked.
- It accepts a payment when `payment.amount >= plan.priceIrr`.
- It does not compare `payment.currency` to IRR or require exact equality.
- It converts Decimal values to JS numbers for comparison.
- The route is production-guarded pending real gateway integration.

**Required later:** bind the payment to the specific plan/purpose and server-calculated amount; require exact integer IRR and exact amount/currency match. Keep this blocked until gateway lifecycle and replay/race controls are verified.

### API-FLOW-05 — Parts API accepts fractional/ambiguous monetary values

File: `src/app/api/jobs/[id]/parts/route.ts`

- Negative unit prices are rejected only if the supplied value is a number.
- Fractional prices and non-finite edge cases are not explicitly rejected.
- Quantity is floored when a number, while money is stored as Decimal.
- The route has no declared currency field or explicit IRR contract.

**Required later:** strict request schema; integer IRR unit price; bounded positive integer quantity; reject string coercion and unsafe integers.

### API-FLOW-06 — Withdrawal amount is bounded but not unit-safe

File: `src/app/api/wallets/withdraw/route.ts`

- It requires a finite positive numeric amount and caps it at 10,000.
- Idempotency and atomic balance decrement are present.
- It does not require `Number.isSafeInteger(amount)`.
- The route does not explicitly state whether request amount is IRR or another unit.
- A separate PR #73 contains USD-base withdrawal thresholds; that policy is not compatible with the IRR-only contract.

**Required later:** make the API unit explicit and IRR-only; require safe integer IRR. Do not set min/max limits until the owner approves them. Resolve or supersede the conflicting PR #73 policy before enabling withdrawals.

### API-FLOW-07 — Pricing engine rounds but does not validate IRR inputs/outputs

File: `src/lib/pricing.ts`

- Decimal.js avoids ordinary binary floating-point composition errors.
- Money fields such as `partsCost` are not validated as safe nonnegative integer IRR.
- Rounded Decimal values are converted to JS number without checking `Number.isSafeInteger`.
- The default labor, travel, tax, emergency and vehicle multipliers are implementation defaults, not approved business terms.
- The package base price is fetched but intentionally unused.

**Required later:** validate money inputs and outputs with the IRR money core; retain decimal precision for hours and distance where those are measurements, not money. Do not change business defaults without approval.

### API-FLOW-08 — Atomic wallet helpers guarantee consistency, not currency correctness

Files: `src/lib/prepay-atomic.ts`, `src/lib/wallet-release.ts`, `src/lib/withdrawal-atomic.ts`

- Atomicity, idempotency, balance guards and rollback protections are valuable.
- These helpers receive numbers and persist Decimal values.
- They do not establish whether those numbers are IRR, integers, nonnegative, or derived from a verified source.
- A perfectly atomic transaction can still atomically persist an incorrect unit.

**Required later:** validate at public API boundaries and again at the shared financial writer boundary. Preserve existing atomic behavior and add unit/integer tests.

, conflicting with the persisted invoice currency.
6. **No CARE-to-invoice/payment bridge was found in the inspected routes.** The CARE approval response only returns the updated approval. Do not assume customer approval automatically adds the accepted proposal to an invoice or payment. A deliberate, idempotent handoff design is required if CARE extras are intended to be billable through the invoice system.

**Required sequence:** first fix the shared money-unit model/formatting and explicitly represent the CARE Toman input boundary; then define an idempotent conversion-and-handoff to IRR-backed invoice line items; then make approval/rejection state transitions atomic and revalidate the proposal contract. Keep historical rows quarantined until their unit is classified. No code or database changes were made by this trace.

## 4. Existing protections to preserve

- Invoice amount fields are not editable through `PATCH /api/invoices/[id]`.
- Payment amount is copied from the persisted invoice, not accepted from the payment request body.
- The payment simulator is production-guarded.
- Prepay simulator is production-guarded.
- Withdrawal uses an idempotency key and an atomic balance check/debit.
- Wallet release is atomic across the supported D1 and Prisma implementations.
- CARE approval is bound to the booking owner and proposal record.
- Technician part writes require assigned-technician/admin authorization.

These protections must not be weakened while adding money-unit validation.

## 4A. Open PR dependency and CI review (2026-11-02)

The open financial/security PRs were checked against their exact current head commits. A green CI result proves the branch passed its configured automation; it does not prove the branch is safe to merge under the IRR-only product contract.

| PR | Scope | Head CI | Dependency / disposition |
|---|---|---|---|
| #75 | Canonical integer-IRR primitives | 5/5 green | Independent foundation; review and integrate before adopting it in routes |
| #68 | CARE proposal validation | 5/5 green | Validates Toman inputs; keep as an explicit Toman ingress contract, not as proof of IRR persistence |
| #72 | CARE proposal atomic creation | 5/5 green | **Stacked on #68** (base branch is #68); review/merge #68 before #72 |
| #70 | CARE approval/rejection atomic decisions | 5/5 green | Complements #72; coordinate both CARE branches and regression-test the complete lifecycle |
| #66 | Payment provider verification contract | 5/5 green | Adapter hardening only; does not connect the authoritative persisted payment lifecycle |
| #67 | VIP payment-purpose binding | 5/5 green | Defense-in-depth; still requires exact integer-IRR amount/currency equality in the full VIP lifecycle |
| #71 | Withdrawal destination and atomic payout handling | 5/5 green | Bank/Sheba destination safety; do not treat as complete until withdrawal amount contract is integer IRR |
| #73 | Withdrawal limits based on USD minimum/maximum and decimal precision | 5/5 green | **Do not merge** under the binding IRR-only rule; conflicts with the product currency contract |
| #74 | Financial unit contract audit | 4/4 green | Documentation only |
| #76 | Financial data provenance inventory | 4/4 green | Documentation only |
| #77 | API flow audit | 4/4 green on head `556f98940ffd55936ce2a4074f6d255139a6407f` | Documentation only |

### Safe review order

1. Review and integrate #75 as the policy-neutral integer-IRR foundation.
2. Review #68, then #72 because #72 is explicitly based on #68. Preserve the Toman ingress contract only at the CARE boundary; do not persist Toman as canonical financial money.
3. Integrate #70 with the CARE proposal lifecycle and test creation → customer decision → invoice handoff together. No invoice handoff is currently proven by the audited routes.
4. Review #66 and #67 together with the persisted payment lifecycle. Adapter tests alone are not payment release evidence.
5. Review #71 for payout destination/atomicity, then replace all USD/decimal withdrawal amount assumptions. Do not merge #73 as written.
6. Only after data provenance and approved prices are established, adopt the formatter and shared IRR core in actual financial readers/writers.

**No PR was merged as part of this review.** Branch CI status is not an authorization to merge, and the PRs were not rebased against each other except for the explicit #72 → #68 dependency. Re-run all required workflows on the final merge candidates after integration.

## 5. Implementation order (no commercial assumptions)

1. Introduce the integer-IRR money core at API and shared-writer boundaries; reject ambiguous values rather than coercing.
2. Fix invoice pricing to consume only verified IRR technician/part values and prevent invoice creation when source unit is unknown.
3. Keep CARE Toman isolated to a single explicit conversion adapter, if the Toman API contract is retained.
4. Fix VIP payment matching to exact purpose, currency, amount and safe-integer IRR.
5. Fix prepay after technician fee records have been classified and reconciled.
6. Fix parts and admin package API schemas.
7. Fix withdrawal unit validation; add limits only after owner approval.
8. Add regression tests for fractional values, unsafe integers, string coercion, currency mismatch, overpayment, and conversion exactly once.
9. Rehearse with seeded/demo data and separately with a sanitized copy of production data; never bulk-convert unknown legacy rows.

## 6. Explicit non-actions

This review does **not**:
- modify API behavior, database schema, migration files, seed data, or production configuration;
- enable gateway, payment, prepay, VIP, or withdrawal production routes;
- choose commission rounding, tax rates, tariffs, VIP prices, or withdrawal thresholds;
- convert historical records or infer their unit from magnitude;
- authorize merging any existing PR.

## 7. Source files reviewed

- `src/app/api/invoices/route.ts`
- `src/app/api/invoices/[id]/route.ts`
- `src/app/api/payments/route.ts`
- `src/app/api/vip/subscribe/route.ts`
- `src/app/api/wallets/route.ts`
- `src/app/api/wallets/withdraw/route.ts`
- `src/app/api/care/bookings/[id]/extra-proposal/route.ts`
- `src/app/api/care/bookings/[id]/approve-extra/route.ts`
- `src/app/api/jobs/[id]/parts/route.ts`
- `src/app/api/care/admin/packages/route.ts`
- `src/app/api/prepay/route.ts`
- `src/app/api/prepay/status/route.ts`
- `src/lib/prepay-atomic.ts`
- `src/lib/wallet-release.ts`
- `src/lib/pricing.ts`
