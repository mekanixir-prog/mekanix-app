# MEKANIX — Financial Data Provenance Inventory
**Date:** 2026-11-02  
**Original scope:** Read-only review of `main` at `4e701370d674cdcde40cabba3e360703b249c029`.  
**Follow-up:** Seed-safety status refreshed on 2026-11-03 after PR #101.  
**Purpose:** Identify monetary fields, declared units, seed provenance, and unresolved ambiguity before any IRR-only runtime or data migration work.

> This document records what the checked-in source says. It does not certify the currency of existing database rows, approve tariffs, or authorize conversion of stored values.

## 1. Executive findings

1. The Prisma schema uses `Decimal` for many monetary columns. Decimal storage does not enforce integer IRR, non-negative values, or a currency contract.
2. Several schema comments declare IRR, but the seed script writes values with explicit USD comments into some of those same fields. Invoices and payments are then labelled `IRR` even though they are derived from the mixed-unit seed values.
3. Several other seed amounts have no currency annotation at all. Their units cannot be established from the seed alone.
4. CARE proposal fields and package prices are monetary but have no currency field in their models. The CARE proposal API has previously been identified as Toman-based; that API contract must not be generalized to other money inputs.
5. The original review found destructive seed behavior and an insufficient User-only guard. **Mitigated on 2026-11-03 by PR #101:** direct demo seed now rejects production and checks every Prisma model before any delete; auto-seed is disabled in production, and automatic schema push no longer accepts data loss. This prevents seed execution against a populated database when the current Prisma client can inspect every model. It does not make historical money data trustworthy or authorize running setup against production.
6. No production/historical record can be safely converted from this source review alone. A record-level provenance and ledger reconciliation is still required.

## 2. Monetary field inventory

| Model / field | Schema declaration | Seed or source evidence | Classification / next action |
|---|---|---|---|
| `Technician.hourlyRate` | Decimal default 15; schema comment says IRR | Seed writes `t.rate` values 52–90, with no unit comment; seed technician records use US-oriented demo data | **Ambiguous.** Do not assume IRR or convert. Confirm intended unit and classify all existing rows. |
| `Technician.travelFeeBase` | Decimal default 3; schema comment says IRR | Seed explicitly comments values 3 + i×0.5 as **USD**, with approximate IRR equivalents | **Known seed/schema conflict.** Seed values are USD-labelled; schema comment/default are IRR-labelled. Existing rows need provenance. |
| `Technician.inspectionFee` | Decimal default 7; schema comment says IRR | Seed explicitly labels 7/9/11 as **USD passenger** fees | **Known seed/schema conflict.** |
| `Technician.inspectionFeeHeavy` | Decimal default 20; schema comment says IRR | Seed explicitly labels 20/25/30/35 as **USD heavy** fees | **Known seed/schema conflict.** |
| `Wallet.balance`, `pendingBalance`, `totalEarned`, `totalCommission`, `totalWithdrawn` | Decimal; each schema comment says IRR | Seed writes small values (50+, 20+, 200+, 20+, 100+) without currency annotation | **Ambiguous demo seed.** Do not interpret as real withdrawable funds or use for migration calibration. |
| `Job.inspectionFee`, `travelFee`, `platformCommission`, `netEarnings` | Decimal; no explicit unit comment on these fields | No direct monetary assignment in the reviewed seed job creation block | **Unit not enforced by schema.** Trace each write path and ledger relationship before changing. |
| `Part.unitPrice` | Decimal; no currency field | Seed stores replaced-parts JSON values 340 and 28; these are not the Prisma `Part` model rows and have no unit annotation | **Ambiguous embedded JSON.** Treat separately from `Part.unitPrice`. |
| `Invoice.laborRate`, `laborTotal`, `partsTotal`, `travelFee`, `subtotal`, `taxTotal`, `discount`, `total` | Decimal; `currency` defaults to IRR | Seed derives labor from technician hourlyRate, adds parts values 396 or 92, and travelFeeBase, then writes `currency: "IRR"`; one seeded notification also displays `$78/hr` | **High-risk mixed provenance.** Currency label alone does not prove the amount is IRR. Do not bulk-convert or display as trusted customer history. |
| `Payment.amount` | Decimal; currency defaults to IRR | Seed copies the derived invoice total and labels it IRR | **Inherited ambiguity.** Reconcile against its invoice and source seed lineage. |
| `ServiceCategory.basePrice` | Decimal default 0; no currency field | Seed values 70–220; UI mirror `SERVICE_CATEGORIES.base` repeats those values without units | **Ambiguous placeholder/configuration.** Not an approved tariff. |
| `Referral.rewardAmount` | Decimal default 5; comment says IRR | No seed assignment found in reviewed seed file | **Declared IRR, but runtime writers and historic provenance still require review.** |
| `InsurancePolicy.premiumAmount`, `coverageAmount` | Decimal; premium comment says IRR, coverage has no unit comment | No seed assignments found in reviewed seed file | **Declared/assumed IRR, not enforced.** Verify API inputs and imports. |
| `InsuranceClaim.amount` | Decimal; comment says IRR claimed | No seed assignments found in reviewed seed file | **Declared IRR, not enforced.** |
| `WalletTransaction.grossAmount`, `commissionAmount`, `netAmount` | Decimal; comments say IRR | Schema describes a 10% commission and 12h hold, but comments are not a validated currency/integer constraint | **Declared IRR.** Validate all writers, integer boundaries, and settlement semantics before activation. |
| `WithdrawalRequest.amount` | Decimal; comment says IRR | Main-branch withdrawal route accepts finite positive JS number up to 10,000 and does not require a safe integer; separate PR #73 uses USD-base limits | **Conflicting API policy.** Keep blocked pending the IRR contract and approved limits. |
| `VipPlan.priceIrr` | Decimal; explicitly named IRR | Seed writes 9, 19, 39 with no unit explanation | **Name declares IRR; seed magnitude/provenance is not established.** These are demo values, not approved VIP prices. |
| `PaymentGatewayLog.amount` | Decimal; comment says IRR; currency defaults to IRR | Gateway adapter/lifecycle remains incomplete according to prior PR review | **Declared IRR.** Require server-derived amount and verified provider callback before production. |
| `DiscountCode.value`, `minAmount` | Decimal; no unit contract; `type` defaults to PERCENT | No currency conversion or semantics enforced by schema | **Semantics ambiguous.** Determine whether `value` is percent or fixed IRR for each type; `minAmount` needs explicit IRR contract. |
| `WalletLedger.amount`, `balanceBefore`, `balanceAfter` | Decimal; no currency field/comment | Ledger records are intended to mirror wallet movements but schema does not enforce units | **Critical ledger ambiguity.** Must reconcile against wallet and transaction records before any conversion. |
| `ServicePackage.basePrice` | Decimal; no currency field | Pricing engine fetches it but currently does not apply it to the calculated price | **Ambiguous and currently informational in the reviewed pricing engine.** Do not treat as an active approved price. |
| `CustomerApproval.partPrice`, `laborPrice`, `totalPrice` | Decimal; no currency field | CARE proposal flow previously reviewed as accepting Toman values | **Known CARE boundary issue.** If the external contract remains Toman, convert once only at the explicit CARE-to-invoice boundary (×10); generic IRR parsers must reject Toman. |
| `PartUsage.unitPrice`, `totalPrice` | Decimal; no currency field | CARE actual part usage model | **Ambiguous.** Must inherit a validated booking currency contract and integer-IRR validation. |
| `PricingSnapshot.servicePrice`, `visitPrice`, `laborPrice`, `partsPrice`, `discount`, `taxTotal`, `total` | Decimal; `currency` defaults to IRR | Pricing engine writes rounded values and sets currency to IRR; comments say all amounts are integer IRR | **Intended IRR path**, but input validation and safe-integer output checks remain incomplete. Existing snapshots still require provenance. |
| `PricingSnapshot.taxRate` and `Invoice.taxRate` | Decimal, default 0.09 | Pricing engine hardcodes 9% | **Rate, not a money amount.** It is an implementation default, not an owner-approved tax decision. |
| `ExchangeRateHistory.baseRate`, `multiplier`, `finalRate` | Float; no currency pair fields | Explicit FX history model | **Reference/FX data, not transaction money.** Keep isolated from IRR payment, wallet, invoice, and withdrawal calculations. |
| `User.currency` | String default IRR | Profile preference/configuration, not a monetary amount | **Display/account metadata only.** Must not drive transaction conversion. |

## 3. Seed provenance and destructive behavior

### Seed data is not a trustworthy monetary baseline

The seed script creates demo users, technicians, wallets, jobs, invoices, and payments. Its values mix:
- explicitly USD-labelled technician travel and inspection fees;
- technician hourly rates without an explicit unit;
- unlabelled wallet balances, VIP plan prices, service-category base prices, and parts values;
- invoices and payments whose currency field is set to IRR regardless of the ambiguous or USD-labelled source values.

Therefore, seed-generated invoices/payments cannot be used to infer a valid production IRR tariff or calibrate a blanket conversion factor.

### Seed execution can delete data

The seed script begins by calling `deleteMany()` for notifications, payments, invoices, warranties, reviews, messages, tracking events, parts, diagnoses, jobs, service requests, service areas, certifications, technician specialties, technicians, vehicles, customers, service categories, and users.

The original review found that `ensureSeedData()` checked only `db.user.count()` and could invoke `prisma db push --accept-data-loss` if the User table could not be read. The original direct seed also lacked a production refusal and did not prove all tables were empty.

**PR #101 mitigation merged 2026-11-03** (`5c191f7efdea278611a9a65f39d481072ed37189`):
- `assertDatabaseEmptyForDemoSeed()` checks all 63 Prisma model delegates before any destructive delete and fails closed if a delegate/client cannot be inspected.
- `prisma/seed.ts` rejects `NODE_ENV === "production"` and runs the all-model emptiness guard before deleting records.
- `src/lib/auto-seed.ts` exits in production and removes `--accept-data-loss` from automatic `prisma db push`.
- Unit tests cover populated financial/operational models, unavailable delegates, production startup, and safe schema-push behavior.

**Operational rule:** Do not run demo seeding or setup against a database with data that must be retained. The guard is a safety net, not a substitute for isolated development/staging databases, backups, or an explicit fixture workflow. This mitigation does not classify or reconcile any financial record.

## 4. Required record classification before migration

For each monetary record, capture at minimum:
- table/model and primary key;
- creation timestamp and source workflow;
- whether created by seed, demo import, user input, admin action, payment gateway, CARE proposal, or historical migration;
- original input unit (IRR, Toman, USD, EUR, unknown);
- stored value and currency label at creation time;
- related invoice/payment/wallet/ledger identifiers;
- whether it has been settled, refunded, withdrawn, or otherwise financially acted upon;
- evidence used to establish provenance and reviewer approval.

Classify records as:
- **Verified IRR integer** — supported by an explicit input contract and traceable writer;
- **Verified Toman** — only where the originating API/import explicitly says Toman;
- **Verified foreign currency** — explicit source and currency;
- **Demo/seed** — demonstrably generated by seed or a known fixture;
- **Unknown/mixed** — insufficient or conflicting evidence.

Do not convert unknown/mixed records. Do not infer a record's unit solely from its magnitude, a schema comment, a currency default, or the current UI formatting.

## 5. Safe implementation sequence

1. Establish a record-level provenance report in a read-only environment, including ledger/invoice/payment reconciliation.
2. Add unit-explicit API contracts and strict integer-IRR validators at new transaction boundaries.
3. Fix display formatting only after the stored-unit contract is verified; remove FX from transaction formatting, not from the separate FX-history feature.
4. Add migration guards and explicit handling for unknown/mixed legacy records. No blanket update or automatic multiplication/division.
5. Keep CARE's Toman input, if retained, isolated to one named adapter boundary with tests proving exactly one conversion.
6. Resolve approved commercial inputs (tariffs, tax treatment, VIP prices, commission and settlement rules, withdrawal thresholds) with the owner before enabling them.
7. Rehearse on a copy of production data, reconcile before/after totals, and require backup/restore verification before production migration.

## 6. Source files reviewed

- `prisma/schema.prisma` — monetary models, fields, comments, defaults, and CARE entities.
- `prisma/seed.ts` — demo technician, wallet, VIP, category, job, invoice, and payment values; destructive deletes.
- `src/lib/auto-seed.ts` — production-disabled auto-seed and schema push without `--accept-data-loss` (PR #101).
- `package.json` — `setup` script invokes schema push and seed.
- `src/lib/pricing.ts` — IRR comments, Decimal calculations, hardcoded defaults, package price currently unused, and output conversion.
- `src/lib/constants.ts` — unitless service-category base values and USD/EUR/IRR currency list.
- `src/app/api/wallets/withdraw/route.ts` — amount validation and unresolved safe-integer/unit policy at the time of review.
- `src/lib/seed-safety.ts` and `tests/unit/seed-safety.test.ts` — all-model empty-database guard and regression tests (PR #101).

## 7. Explicit non-actions

This inventory does **not**:
- certify the currency of any existing database row;
- approve or set labor, parts, travel, inspection, VIP, tax, commission, or withdrawal amounts;
- convert any existing value or assume every record is IRR;
- authorize live payment, wallet credit, withdrawal, payout, or a production migration.


## Owner decision update — 2026-11-03

The canonical target is now owner-approved: integer IRR for persisted accounting amounts; Toman is presentation-only at 10 IRR per Toman. This decision does not change the classifications above. In particular, USD-labelled seed fees, unlabelled demo wallet balances, ambiguous service/parts prices, and invoices/payments derived from them remain untrusted until their provenance is proven. No magnitude-based inference or blanket conversion is permitted. Keep unknown cohorts quarantined and non-withdrawable. The destructive seed risk is mitigated by PR #101's all-model guard and production refusal. Keep this guard covered by CI and continue to use isolated databases; no database rows were changed by the PR.
