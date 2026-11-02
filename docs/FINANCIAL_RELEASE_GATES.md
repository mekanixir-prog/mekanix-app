# Financial Release Gates

This document defines the evidence required before any financial provenance flag is enabled in production.

## Non-negotiable rule

**Do not enable a flag as a workaround for a blocked screen or API.** Each flag is an attestation that the corresponding source data has been inventoried, classified, reconciled, independently reviewed, and approved by the business owner. A successful build or test run does not establish financial-unit provenance.

No historical financial row is converted by these flags. They only permit the application to interpret a source whose unit has already been verified.

## Required gates

| Environment variable | What it attests to | Required evidence |
|---|---|---|
| `MEKANIX_PRICING_IRR_APPROVED` | Canonical production rate card is approved in IRR | Signed rate card for labor, visit, travel, discounts, tax, and emergency multipliers; matching staging invoice and booking examples |
| `MEKANIX_VIP_PLAN_PRICES_IRR_VERIFIED` | Every active VIP plan price is a whole-IRR amount | Plan-by-plan source review, owner-approved price schedule, and exact-payment test |
| `MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED` | Hourly, inspection, heavy inspection, and travel fee fields are IRR | Full technician-profile export, per-field unit classification, reconciliation report, owner sign-off |
| `MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED` | Existing JobPart unit prices are IRR | Full JobPart export, source-by-source unit classification, reconciliation report, owner sign-off |
| `MEKANIX_WALLET_IRR_PROVENANCE_VERIFIED` | Wallet balances, wallet transactions, withdrawal requests, and ledgers are IRR | Opening/closing balance reconciliation, gross/commission/net tie-out, withdrawal/debit/refund matching, independent review, owner sign-off |

## Safe verification sequence

1. Keep all flags unset or `false` in production.
2. Export source records read-only. Preserve IDs, timestamps, source references, and original values.
3. Classify each legacy source as IRR, Toman, USD, or unknown. Unknown must remain unknown; never infer a unit from the magnitude alone.
4. Reconcile totals and relationships without updating production rows. Record exceptions and unresolved rows.
5. Have a second reviewer verify the report and the business owner approve the rate card and unit classifications.
6. Test the exact production configuration in staging with representative invoices, CARE bookings, technician fees, VIP subscriptions, wallet prepay, release, withdrawal, and refund/rejection scenarios.
7. Enable only the flag whose full evidence is complete. Do not enable the wallet flag merely because technician fee units are verified; both are required before prepay can write to a wallet.
8. Monitor the first controlled production transactions and compare application values to the approved source schedule and bank records.

## Cross-system constraints

- Invoice issuance and CARE booking creation require the approved canonical IRR rate card.
- VIP checkout requires verified VIP plan prices.
- Technician fee display/edit and prepay amount calculation require verified technician fee units.
- Prepay writes require **both** verified technician fee units and verified wallet ledger units.
- Legacy JobPart prices remain hidden and invoice creation remains blocked until JobPart provenance is verified.
- Wallet reads redact monetary values and do not repair/release escrow while wallet provenance is unverified. Withdrawal creation, status amount display, and admin settlement remain blocked/redacted until wallet provenance is verified.
- Manual payment refund status and invoice cancellation are intentionally blocked until an audited refund/cancellation state machine exists. Do not use a status edit as a substitute for an actual refund.

## Explicitly out of scope

- No historical database conversion is performed by this PR.
- No seed data or technician profile values are automatically relabelled.
- No payment provider, SMS provider, hosting, domain, or production environment setting is activated here.
- A green CI run proves code/build behavior only; it does not replace financial reconciliation or owner approval.
