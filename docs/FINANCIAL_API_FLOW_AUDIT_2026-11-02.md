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
| #77 | API flow audit | 4/4 green on head `30dcf03c03f33a1e8efe6427f2abe720cad37d4c` | Documentation only |

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

## 8. Shared formatter and display-consumer trace (2026-11-02)

This section records source-level findings from `main` at `4e701370d674cdcde40cabba3e360703b249c029`. It does not change runtime behavior.

### 8.1 Root formatter defect

- `src/lib/format.ts::fmtMoney` treats every value passed with currency `IRR` as a USD-base amount and multiplies it by the mutable `USD_TO_IRR` rate (default 60,000).
- `src/lib/use-t.ts::useT().money` forces the currency argument to `IRR` whenever the UI language is Persian, regardless of the source record's actual unit.
- The same hook fetches `/api/exchange-rate` on mount and refreshes the rate every five minutes. This means the displayed value of a persisted amount can change as the FX rate changes, even when the underlying record does not.
- Therefore the current formatter contract is not “format a persisted IRR amount”; it is “multiply an assumed USD-base amount by a live rate, then label it IRR.” That contract conflicts with the product's IRR-only money requirement and is unsafe for any already-IRR or Toman value.

### 8.2 Known display callsites and unit evidence

| Consumer | Fields passed to `money()` | Source evidence | Current disposition |
|---|---|---|---|
| `src/components/mek/customer/care-detail.tsx` | CARE pricing snapshot fields; extra proposal part/labor/total | Booking pricing is produced by `src/lib/pricing.ts` and explicitly declares integer IRR. Extra-proposal ingress is explicitly Toman in API validation/notification contract, and PR #68 validates Toman. | **Mixed units on one screen.** Snapshot values are intended IRR; proposal values are Toman. A single `money()` function cannot correctly render both. |
| `src/components/mek/customer/invoice.tsx` | Invoice totals, labor, parts, travel, payment labels | Invoice API labels persisted records IRR, but technician and part source values are not proven IRR. Seed data writes USD-labelled technician travel/inspection fees into invoice calculations, then labels invoice IRR. | **Unverified persisted unit.** Do not route through `formatIrr` until upstream records and historical invoices are reconciled. |
| `src/components/mek/customer/invoice-document.tsx` | Invoice line rates, totals, parts and travel | Same Invoice/Part/Technician source as customer invoice. | **Unverified persisted unit.** Same restriction as invoice screen. |
| `src/components/mek/technician/earnings.tsx` | Wallet balance, pending balance, earned, commission, transactions, withdrawals | Values come from wallet/ledger records. Atomicity and idempotency are present, but no verified integer-IRR source contract was found in the audited paths. | **Unverified persisted unit.** Needs ledger-origin trace before formatter migration. |
| `src/components/mek/admin/technicians.tsx` | Technician hourlyRate | Technician profile field; schema default/comment says IRR, but seed rate values are 52–90 with no unit declaration and technician travel/inspection seed fields explicitly say USD. | **Ambiguous profile unit.** Do not assume the schema comment proves actual stored values. |
| `src/components/mek/customer/care-booking.tsx` | Service package basePrice and client-side preview formula | Pricing engine explicitly says package basePrice is informational and unused in the final calculation. Package API/schema does not establish a safe IRR contract in the inspected route. | **Unspecified package unit.** The preview formula is not proof that basePrice is an approved tariff or canonical IRR. |

The above is a confirmed list of reviewed callsites, not a claim that no other `money()` callsites exist. A complete repository-wide callsite inventory remains a required implementation gate.

### 8.3 Seed-data provenance conflict

The reviewed `prisma/seed.ts` has material contradictions:

- Technician `travelFeeBase`, `inspectionFee`, and `inspectionFeeHeavy` are explicitly annotated as USD values, while the Prisma schema comments describe the corresponding fields as IRR.
- Seeded technician hourly rates use values from the seed technician list (e.g. 52–90) without a declared currency/unit at assignment.
- Seed-generated invoice calculations consume these technician values and then persist `currency: "IRR"`; the same pattern appears in more than one seed invoice block.
- VIP seed rows write `priceIrr` values of 9, 19, and 39. Those values are not enough to infer whether the intended unit is IRR, Toman, or an abbreviated display amount; no conversion is justified from magnitude alone.

Consequently, a clean seed run is not evidence of an IRR-correct demo dataset. Seed values and demo invoices need an explicit, internally consistent IRR contract before visual QA or financial acceptance tests can be trusted.

### 8.4 Safe formatter migration gates

1. Keep the existing formatter behavior unchanged until each persisted source field is classified; do not globally remove the FX multiplier while USD-base legacy data may exist.
2. Use the canonical `formatIrr` primitive only for values proven to be integer IRR at the writer and persistence boundary.
3. Keep CARE proposal Toman ingress on an explicitly named Toman formatter until a single, tested Toman-to-IRR adapter is implemented for the full proposal-to-invoice lifecycle.
4. Do not use a live FX rate to render stored IRR, Toman, wallet, invoice, VIP, or package amounts.
5. Add explicit unit types/adapters and regression tests for every reviewed screen, including tests proving that a rate refresh cannot change the rendering of a persisted IRR amount.
6. Before calling the inventory complete, search every repository occurrence of `money(`, `fmtMoney(`, and direct currency formatting, and classify each source field—not just each component.

**No runtime formatter, seed, schema, migration, or historical record was changed by this trace.**

### 8.5 Exchange-rate endpoint adds a second display instability

The exchange-rate endpoint was inspected after tracing the hook:

- `src/app/api/exchange-rate/route.ts` prefers a Telegram-stored rate, then calls `open.er-api.com/v6/latest/USD`, then falls back to a hard-coded `6,000,000` IRR per USD.
- `src/lib/format.ts` initializes its in-memory rate to `60,000`, while the endpoint's final fallback is `6,000,000`. If the endpoint falls through to its fallback, the displayed multiplier changes by 100× after `useT()` fetches it.
- The endpoint also applies an admin-configured multiplier and caches its result for 60 seconds. The hook refreshes every five minutes.
- The formatter's live-rate dependency therefore creates both a unit-contract defect and a visible timing/rate discontinuity. This is not an acceptable way to render persisted Iranian Rial amounts.

**Required separation:** keep foreign-exchange rates in a dedicated FX/market-data feature for explicit USD↔IRR conversions only. Remove FX-rate fetching from the general-purpose money display hook only after all consumers have migrated to explicit unit-aware formatters. Do not repurpose or silently change the FX endpoint as part of the formatter fix.

### 8.6 Expanded UI consumer trace: additional currency and estimate defects

A targeted source pass over 19 money-bearing UI/helper files found additional consumers beyond the first customer invoice and CARE detail trace. This is a targeted inventory, not yet a mathematically exhaustive repository-wide callsite census (GitHub code search returned no indexed matches for the formatter names).

| Consumer | Displayed values | Source/provenance result |
|---|---|---|
| `src/components/mek/admin/payments.tsx` | Payment amount, total successful volume, average transaction | Uses `money()` on API payment amounts. The screen does not inspect or branch on each payment's `currency`; mixed or non-IRR records would be silently relabelled in Persian. |
| `src/components/mek/admin/withdrawals.tsx` | Withdrawal amount | Formats raw withdrawal amount with `money()`; no unit metadata is present in the component row type. |
| `src/components/mek/admin/overview.tsx` | 30-day revenue, category revenue, technician revenue | Dashboard aggregate fields are formatted as if they shared the UI language's currency. Their aggregation/source unit must be traced in the dashboard API before IRR can be asserted. |
| `src/components/mek/admin/jobs.tsx` | Invoice total | Displays invoice total without checking invoice currency. |
| `src/components/mek/admin/technicians.tsx` | Technician hourly rate | Displays `hourlyRate` as money. Seed values 52–90 are not unit-labelled at assignment; schema comments and seed fee annotations conflict elsewhere. |
| `src/components/mek/shared/technician-card.tsx` | Inspection fee, travel fee, hourly rate | Formats optional fee fields and hourlyRate identically. Their source unit is not carried in the component contract. |
| `src/components/mek/technician/profile.tsx` | Hourly rate, travel fee inputs | Reads/writes technician profile fields but the UI input has no currency/unit label or conversion contract. |
| `src/components/mek/technician/job-detail.tsx` | Parts, labor estimate, travel fee, estimated total | Recomputes a client-side estimate from hourlyRate, part unitPrice and travelFeeBase, then adds a hard-coded 9%. It does not call the canonical CARE pricing engine; the estimate can diverge from the invoice calculation and inherits the unresolved source-unit conflicts. |
| `src/components/mek/technician/dashboard.tsx` | Today/week earnings | Sums completed invoice totals and labels them as technician earnings/revenue. Invoice total is customer gross, not proven technician net earnings; this is a semantic mismatch even if the currency is corrected. |
| `src/components/mek/technician/earnings.tsx` | Wallet balance, pending, total earned, commission, withdrawals, transaction net | Wallet API payload has no currency field in the local UI types. The UI declares `MIN_WITHDRAWAL = 5 // USD` and renders the minimum with a literal `$`, while the app's Persian `money()` formatter relabels displayed balances as IRR. This is a direct USD/IRR contract conflict requiring server + schema + seed reconciliation, not just a display change. |
| `src/components/mek/shared/payment-gateway.tsx` | Payment amount | Prop contract explicitly says `amount: number; // USD`, while the component is an Iranian gateway simulator and displays it through the Persian formatter as IRR. The gateway initiate/verify APIs must be traced to determine whether amount is USD, IRR, or a stale comment; do not assume. |
| `src/components/mek/customer/care-booking.tsx` | Package price and estimated service/visit/labor/parts/total | The review panel synthesizes labor as 40% and parts as 50% of package base price, adds a 15,000 visit fee and 9% tax. These figures are a UI-only estimate and are not the canonical `calculatePrice()` result; package basePrice is explicitly informational/unused by that engine. The screen must not present this as an authoritative quote until a single server-calculated snapshot is returned. |
| `src/components/mek/customer/invoice.tsx`, `invoice-document.tsx` | Labor, parts, travel, subtotal, discount, tax, total | All use `money()` for persisted invoice fields. The invoice currency field is not used to select a formatter. |
| `src/components/mek/shared/payment-gateway.tsx` | Payment amount | Also uses the same general `money()` function; purpose does not constrain the amount's unit. |

#### Findings that should become explicit release blockers

1. **Hard-coded USD residue in user-facing flows:** `PaymentGatewayDialog.amount` is documented as USD; technician minimum withdrawal is 5 USD and shown with `$`. This conflicts with the product requirement that MEKANIX amounts be Iranian Rial. First establish the actual persisted/API unit; then migrate the contract and tests. Do not simply change the label or multiply by an exchange rate.
2. **Currency metadata is ignored at display boundaries:** invoice/payment/wallet rows are formatted without checking their persisted currency or an explicit typed unit. A Persian locale currently forces IRR formatting, which is not proof that the source amount is IRR.
3. **Two independent estimate calculators:** technician job detail and CARE booking review each synthesize estimates in the browser. The canonical `src/lib/pricing.ts` engine has different inputs/rules and returns a persisted snapshot. These UI estimates can mislead users even if the formatter is fixed.
4. **Revenue is not technician earnings:** technician dashboard sums invoice totals, while earnings page uses wallet net/commission values. Keep gross invoice revenue and technician net earnings as distinct metrics.
5. **No amount-unit inference by magnitude:** values such as 5, 52, 15,000 or 6,000,000 cannot be classified from size alone. Historical and seed rows require provenance, explicit currency/unit fields, and a reconciliation report.

#### Safe migration order

- Build a source-field matrix from Prisma schema, migrations, seed writers, API writers/readers, and UI consumers for: `hourlyRate`, `travelFeeBase`, `inspectionFee`, `JobPart.unitPrice`, invoice monetary columns, payment amount/currency, wallet ledger amounts, withdrawal amount, CARE package `basePrice`, and extra-proposal amounts.
- Define a single canonical persisted unit for all MEKANIX domestic monetary values: integer IRR. Keep Toman only at explicitly named input/compatibility boundaries, converting exactly once before persistence. Keep USD only in explicitly typed FX/external-market contexts.
- Require currency/unit metadata or a typed domain boundary for legacy values until each dataset is reconciled. Do not default unknown legacy values to IRR.
- Replace client-side quote arithmetic with server-returned, versioned pricing snapshots; display the snapshot's currency and unit, not the locale's preferred currency.
- Make payment, invoice, wallet, withdrawal, admin aggregates, and technician earnings use the same validated integer-IRR contract while preserving distinct gross/net semantics.
- Add tests proving: Persian locale never changes the source unit; FX refresh cannot change IRR display; a USD amount cannot enter an IRR-only writer; unknown currency is rejected/quarantined; UI estimate equals the server snapshot; gross invoice revenue is not presented as net technician earnings.

**No runtime code, schema, seed, migration, production configuration, or historical financial record was changed by this expanded trace.**

### 8.7 Server contract resolves two apparent UI comments—and exposes a stricter mismatch

The gateway and withdrawal server paths were inspected after the UI pass:

- `src/app/api/gateway/initiate/route.ts` persists `PaymentGatewayLog.amount` with `currency: "IRR"`; `verify` copies the log amount and currency into `Payment`. Thus the `PaymentGatewayDialog.amount // USD` annotation is stale or incorrect relative to the current simulator server contract. However, initiate is explicitly development-only, accepts the amount from the client, and returns 404 in production. The production provider must derive amount from the linked invoice/plan, not this client amount.
- The gateway route's cap is `100_000_000` and its comment explicitly describes that cap as IRR. It does not validate integer/safe-integer status or prove that the client amount was produced by the invoice/plan. Do not treat its `currency: "IRR"` assignment as proof of correct commercial pricing.
- `prisma/schema.prisma` explicitly labels wallet balance, pending balance, total earned, commission, total withdrawn, wallet transaction gross/commission/net, and withdrawal amount as IRR.
- `src/app/api/wallets/withdraw/route.ts` accepts any finite positive number up to `10_000`; it has no lower bound and no currency field in the request. It does not enforce an integer or safe integer. The UI's `MIN_WITHDRAWAL = 5 // USD` and literal dollar display therefore do not match the current server's apparent IRR amount contract or its maximum. This is a real cross-layer defect, not merely an outdated comment.
- `prisma/seed.ts` initializes wallet balances and lifetime totals with small unlabelled values (for example balance 50, pending 20, totalEarned 200). Schema comments say IRR, but the seed does not declare a unit or realistic demo-money convention. These rows must be explicitly marked as demo fixtures or regenerated with a documented IRR fixture policy; do not infer USD or IRR solely from magnitude.
- The technician seed assigns `travelFeeBase`, `inspectionFee`, and `inspectionFeeHeavy` in USD in comments while Prisma schema comments say IRR. Invoice seed writers then copy calculated values into invoices whose currency is IRR. This is a confirmed seed-to-invoice unit provenance break.

**Correction to §8.6:** the gateway API's current simulator persistence contract is explicitly IRR, even though the component prop comment says USD. The unresolved issue is the disagreement between the UI annotation, client-controlled development amount, and production-provider requirements—not an unknown currency value on the current simulator log/payment rows.

### 8.8 Dashboard and payment-ledger aggregation trace

The dashboard API, payment admin screen, technician dashboard, technician earnings screen, payment schema, and invoice payment writer were inspected together.

| Path | Current calculation / display | Financial correctness issue |
|---|---|---|
| `src/app/api/dashboard/route.ts` | `revenue30d` sums every SUCCEEDED payment amount created in the last 30 days. Daily series repeats the same unfiltered sum. | No `currency` predicate or normalization is applied. A mixed-currency dataset is arithmetically aggregated. The endpoint also labels the result as revenue without defining gross/net, refunds, or settlement basis. |
| Same dashboard API: category revenue | Sums linked invoice totals for all service requests in each category. | Does not filter invoice status, payment status, or currency; it is billed/invoiced value, not necessarily realized revenue. |
| Same dashboard API: technician performance | Sums all SUCCEEDED payments linked to invoices for a technician. | No currency filter; gross customer payments are labelled technician revenue/performance, not technician wallet net. |
| `src/components/mek/admin/payments.tsx` | Sums all rows with status SUCCEEDED and formats each amount with `money()`. | The component receives `Payment.currency` through the Prisma type but ignores it both in row formatting and total/average. The admin total can combine unlike currencies. |
| `src/components/mek/technician/dashboard.tsx` | Derives “today” from the first two completed jobs and “week” from every completed job returned by `listJobs`. | The code itself calls this a mock. It does not filter by date; “today” is not actually today and “week” is not actually this week. It sums invoice totals (customer gross), not wallet net earnings. |
| `src/components/mek/technician/earnings.tsx` | Wallet KPIs use Wallet fields; 14-day chart instead sums payment amounts from completed-job invoice payments. | The chart is based on customer payment gross, while the adjacent KPIs are wallet balances/net/commission. The same “earned/revenue” visual grouping mixes different financial meanings. Payment currency is not checked in the chart. |
| `src/app/api/payments/route.ts` | New payment amount and currency are copied from `inv.total` and `inv.currency`. | The normal writer preserves invoice currency, which is good, but downstream aggregators ignore it. The notification body still renders a dollar sign with the invoice total, contradicting an IRR invoice. The simulator is production-blocked. |
| `prisma/schema.prisma` Payment | `amount Decimal`, `currency String @default("IRR")`. | Currency is stored per payment, but no enum/check constraint or repository-wide invariant enforces IRR-only domestic payments. A default does not validate legacy or explicitly supplied values. |

#### Additional verified issues

1. **Admin payments total is not currency-safe.** The API returns Payment rows with their currency field, but the UI reduces all successful amounts together and formats each with the locale-driven `money()`. A non-IRR row would be silently included in an IRR-looking total.
2. **Platform dashboard revenue is not currency-safe.** `/api/dashboard` sums successful payment amounts without `currency: "IRR"` and does the same for each daily bucket and technician-performance bucket. If MEKANIX is to be IRR-only, reject/quarantine non-IRR domestic payment rows at write/read boundaries rather than silently mixing them.
3. **Category “revenue” is actually invoice value.** It sums invoice totals regardless of invoice/payment state; unpaid, refunded, or draft/overdue invoice values may be counted. Rename the metric to invoiced amount or calculate collected revenue from succeeded payments with a defined refund policy.
4. **Technician gross/net semantics are mixed.** Admin performance and technician dashboard use customer-side invoice/payment gross, while wallet `totalEarned` and `netAmount` are technician-side amounts after commission. Do not call gross invoice value “technician earnings”.
5. **Technician dashboard date labels are incorrect.** The source comments say “mock today/week earnings”; today is the first two completed jobs in the returned list and week is all completed jobs. Replace with server-authoritative time-windowed wallet ledger aggregates, or label as lifetime/sample totals until that exists.
6. **Technician earnings chart is a different measure from wallet KPIs.** It plots payment amounts, while wallet cards show balance/pending/net/commission. The graph must use the same ledger definition as the selected KPI (for example, net earnings credited/released) and the same explicit IRR unit.
7. **Payment notification has a hard-coded dollar sign.** `src/app/api/payments/route.ts` emits a dollar sign before the invoice total even though the persisted payment copies the invoice currency and the product requirement is IRR.

#### Required dashboard contract before release

- Define separate server metrics: `collectedGrossIrr` (successful customer payments, net of explicitly handled refunds), `invoicedIrr` (invoice totals by invoice status), `technicianNetEarnedIrr` (wallet ledger net credits), `commissionIrr`, and `withdrawnIrr`.
- All sums must be computed from canonical integer-IRR ledger values, with explicit currency filtering/validation. Unknown or non-IRR rows must not enter an IRR aggregate.
- Date-window metrics must filter on the business event timestamp chosen for the metric (payment created/settled, invoice issued, wallet released), not on a convenient unrelated timestamp.
- Dashboard response types must include metric names and currency/unit metadata; frontend must not infer the unit from language.
- Add fixtures for IRR-only, mixed-currency, refunded, unpaid, and technician commission cases. Assert that mixed/unknown currencies cannot inflate IRR KPIs and that gross customer payments differ from technician net earnings where commission applies.

**No runtime code, schema, migrations, seed rows, financial history, or production settings were modified by this dashboard trace.**

### 8.9 Pre-service payment and wallet-ledger provenance

The prepay writer, atomic Prisma/D1 implementations, wallet read/release path, and withdrawal reconciliation endpoint were inspected.

- `src/app/api/prepay/route.ts` computes gross as technician `inspectionFee` + `travelFeeBase`, commission as 10% of gross, and net as gross minus commission. These source fields have the seed/schema unit conflict already recorded in §8.5/§8.7. The route copies the computed amounts into Job fields and wallet records without a currency/unit field.
- The route is a simulator and explicitly returns 404 in production. That prevents current production use, but the data contract still must be corrected before enabling a real provider.
- `recordPrepayWithPrisma` and `recordPrepayWithD1` persist wallet transaction gross/commission/net and ledger amount/balance snapshots as Decimal/SQLite numeric values, but the records do not carry currency. The atomicity/idempotency work is useful but does not establish the monetary unit.
- The Prisma wallet aggregate increments `totalEarned` by gross and `totalCommission` by commission; `pendingBalance` receives net. Therefore the field name `totalEarned` is documented in schema as lifetime gross, while the technician UI labels it “net earnings”. This is a semantic labeling mismatch.
- The prepay wallet transaction is created with status `PENDING` and `holdUntil: null`; the generic wallet release path only releases PENDING rows with non-null matured `holdUntil`. The prepay route's Job row sets `holdUntil: null` too. The source reviewed here does not establish how this prepay hold is later released; identify the separate release trigger/flow before relying on it. Do not assume the generic `/api/wallets` auto-release will release this particular prepay transaction.
- `src/app/api/wallets/route.ts` returns wallet values without currency metadata. It does release matured transactions before returning a refreshed wallet; the release transition is atomic, but currency remains implicit.
- `src/app/api/wallets/withdraw/status/route.ts` correctly checks that a withdrawal request has a matching immutable negative ledger entry before reporting COMMITTED. It compares amount equality but has no currency field to verify.
- `src/app/api/wallets/withdraw/route.ts` validates only finite positive amount and a maximum of 10,000; it does not require an integer/safe integer or a currency field. The database schema comments say IRR, so this is an apparent IRR-only route with no explicit boundary assertion.
- `src/components/mek/technician/earnings.tsx` calls `parseFloat` on user-entered withdrawal text, uses `MIN_WITHDRAWAL = 5 // USD`, and shows a dollar sign in the minimum error. It posts that raw number to the IRR-labelled API. A technician entering “5” is therefore ambiguous by a factor that must not be guessed.

#### Wallet/prepay release blockers

1. Resolve technician fee seed units and historical fee values before enabling prepay in a real payment flow.
2. Add a canonical integer-IRR validation boundary to prepay input derivation, commission calculation, wallet transaction writes, and ledger writes; reject unsafe/fractional values.
3. Add explicit unit metadata or an IRR-only invariant for wallet and ledger records; do not infer unit from the Persian locale or schema comments alone.
4. Decide whether `totalEarned` means gross lifetime amount or net technician earnings. Preserve gross and net as separate fields/metrics and label them accurately in UI.
5. Trace the prepay hold-release lifecycle. The generic release helper requires non-null `holdUntil`, while prepay rows currently have null. Verify a separate, idempotent completion-time hold scheduler or fix the lifecycle before production.
6. Replace USD minimum withdrawal text with the owner-approved IRR policy only after the intended amount scale and historical wallet data are reconciled. Do not just replace the string “$” with “ریال”.
7. Preserve the existing atomicity and reconciliation checks while adding currency/safe-integer constraints; do not weaken idempotency or transaction boundaries.

**No runtime code, schema, migration, seed row, historical wallet balance, or production configuration was changed by this wallet/prepay trace.**

