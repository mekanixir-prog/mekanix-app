# Financial Provenance Reconciliation Runbook

**Status:** Read-only inventory and controlled staging procedure. This is not authorization to alter historical balances or enable money movement.

## Non-negotiable rules

1. Never infer IRR, Toman, USD, or another unit from numeric magnitude, display formatting, seed value, table name, or current UI.
2. A currency label by itself is not proof of provenance.
3. Never bulk-convert, relabel, or mark historical records VERIFIED_IRR without row-level evidence and a reviewed migration.
4. Unverified values remain masked and ineligible for payment, withdrawal, settlement, commission, VIP activation, or referral payout.
5. All reconciliation and any eventual correction must be append-only/audited, idempotent, and transactionally safe on both PostgreSQL and D1.

## Phase A — Prepare a controlled snapshot

- Use an isolated staging clone, not production.
- Capture the source environment, snapshot identifier, database schema/migration version, application commit SHA, timestamp, and operator.
- Restrict database access to read-only credentials for the inventory stage.
- Preserve the raw query output and compute an artifact checksum outside the application database.
- Do not copy real customer PII into an unapproved test environment.

## Phase B — Run the inventory

Run scripts/audit-financial-provenance.sql with a read-only connection.

The script reports:
- Counts by financialUnitStatus for 19 financial models.
- Separate valueUnitStatus and minAmountUnitStatus counts for DiscountCode.
- Records claiming VERIFIED_IRR while their explicit currency column is not IRR.
- A capped list of at most 1,000 record IDs and status values for controlled follow-up; no monetary values or personal attributes are emitted.

The PostgreSQL CI job executes the same SQL after all PostgreSQL migrations have been applied. This validates query/schema compatibility on an empty CI database; it is not a substitute for a staging data report.

## Phase C — Classify each row with evidence

For each candidate row, retain a separate reconciliation record containing:
- Table/model and record ID.
- Original source system/import batch and creation timestamp.
- Source document/reference (provider settlement, signed contract, approved rate-card version, invoice, wallet ledger event, or validated import record).
- Explicit unit and currency.
- Exact source amount and expected canonical amount, without rounding or silent conversion.
- Evidence reviewer and independent approver.
- Classification: VERIFIED_IRR, UNVERIFIED, or QUARANTINED.
- Reason code and reconciliation artifact reference.

A row can become VERIFIED_IRR only when evidence establishes the exact unit and the stored value is a positive/allowed safe integer under the relevant model contract. Legitimate negative ledger entries or zero-valued records require their own model-specific policy; do not apply one blanket positivity rule to all tables.

## Phase D — Reconcile linked financial evidence

At minimum, reconcile these chains by stable IDs:
- Invoice → Payment → PaymentGatewayLog → provider reference.
- Wallet → WalletTransaction → WalletLedger.
- WithdrawalRequest → debit ledger entry → provider/bank payout evidence.
- VIP plan snapshot → gateway attempt → verified payment → subscription/outbox event.
- Referral → approved reward contract → wallet owner → credit ledger entry.

Any missing link, duplicate, amount/currency mismatch, ambiguous legacy row, or out-of-order transition remains quarantined and must not be fixed by editing the historical amount.

## Phase E — Apply an approved correction (separate change)

No correction SQL belongs in the inventory script.

Before any correction:
- Obtain explicit finance/product-owner approval of the unit, conversion rule, beneficiary, and business semantics.
- Prepare a separate migration/script with a dry-run mode and a deterministic row allowlist.
- Require expected row counts and precondition hashes; abort on drift.
- Write an immutable reconciliation/audit event and compensating ledger entry where appropriate.
- Use a transaction or D1 batch with compare-and-set and idempotency keys.
- Verify before/after values and all linked records from a second independent read.
- Test the exact migration against PostgreSQL and D1/SQLite fixtures, including rollback and retry.

## Release exit criteria

- Zero unexplained VERIFIED_IRR currency contradictions.
- Every production-readable amount is backed by the appropriate row-level provenance.
- Unverified/quarantined values remain masked across all public and customer endpoints.
- No historical balance is changed by a bulk conversion.
- All corrections have owner approval, reviewer evidence, immutable audit references, and successful rollback/recovery tests.
- Payment, wallet credit, withdrawal, referral payout, and VIP fulfillment remain fail-closed until their own lifecycle contracts are independently complete.
