# MEKANIX Financial Record Provenance Contract

**Status:** implementation foundation; not a historical-data approval  
**Canonical accounting unit:** integer IRR  
**Persian presentation:** exact Toman conversion (10 IRR = 1 Toman), only after a record is verified

## Status meanings

Every covered financial record carries `financialUnitStatus`:

- `UNVERIFIED` — default for all pre-existing rows and any new row whose writer has not explicitly established its unit. Do not expose its amount as usable money and do not use it for payment, wallet credit, withdrawal, or payout.
- `VERIFIED_IRR` — the writer or reviewed reconciliation has established that the record's monetary values are safe integer IRR. If the model also has a currency field, it must equal `IRR`.
- `QUARANTINED` — evidence is contradictory, mixed, or insufficient and the row has been deliberately isolated. It must remain unavailable for financial use.

Currency labels, numeric magnitude, environment variables, seed names, and current display formatting are not provenance evidence.

## Covered records

The schema adds record-level status to Technician, Job, Part, Invoice, Payment, ServiceCategory, Referral, InsurancePolicy, InsuranceClaim, Wallet, WalletTransaction, WithdrawalRequest, VipPlan, PaymentGatewayLog, WalletLedger, ServicePackage, CustomerApproval, PartUsage, and PricingSnapshot.

The status applies to the monetary fields belonging to that record. If a future model mixes currencies or independently sourced amounts within one row, it must use field-level attestations rather than overloading this record-level status.

## Migration behavior

- Both SQLite/D1 and PostgreSQL receive the same additive `TEXT NOT NULL DEFAULT 'UNVERIFIED'` column migration.
- Existing rows receive `UNVERIFIED` through the database default.
- No amount is multiplied, divided, rounded, relabelled, or bulk-converted.
- The migration does not enable any production readiness flag and does not authorize financial movement.

## Writer contract

A writer may set `financialUnitStatus = "VERIFIED_IRR"` only after it has:
1. validated every monetary input as a safe integer IRR value;
2. validated derived totals with safe integer arithmetic or an explicitly approved decimal/rational rule;
3. verified source-unit provenance for every input component;
4. confirmed the relevant owner-approved rate card and commercial policy where applicable; and
5. persisted the data and status together in the same atomic write boundary.

Otherwise the record remains `UNVERIFIED`. A status must never be upgraded merely because an environment variable is true.

## Read contract

A financial read API may expose a numeric amount only when `financialUnitStatus === "VERIFIED_IRR"` and any explicit currency column is `IRR`. Otherwise return `null` for the financial value and a non-sensitive status such as `UNVERIFIED` or `QUARANTINED`; retain safe non-financial metadata.

The helper `isVerifiedIrrRecord` implements this fail-closed predicate. It does not query or mutate data.

## Rollout order

1. Deploy the additive schema migrations.
2. Apply read-side masking to wallet, invoice, payment, withdrawal, and other financial read APIs.
3. Update each writer independently to validate and attest only newly verified records.
4. Inventory historical records and reconcile them from source evidence.
5. Upgrade historical records only through reviewed, reversible, row-scoped reconciliation with backup/restore evidence.
6. Enable Toman presentation only for verified IRR values.

Until these steps are complete, issue #81 and issue #130 remain release blockers. Live payment, wallet credit, withdrawal, and payout remain disabled.
