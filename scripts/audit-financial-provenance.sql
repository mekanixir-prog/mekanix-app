-- MEKANIX financial provenance inventory (READ ONLY)
--
-- Purpose:
--   Inventory record-level financial attestations before any historical
--   reconciliation or production money-movement enablement.
--
-- Safety:
--   SELECT-only. This script does not update, relabel, quarantine, convert,
--   or delete any financial value. Run first against an isolated staging
--   clone with read-only credentials. Preserve the output with the database
--   snapshot identifier and exact application SHA.
--
-- Canonical contract:
--   VERIFIED_IRR means an independently evidenced integer-IRR record.
--   UNVERIFIED / QUARANTINED / NULL must not be interpreted as IRR.
--   This report deliberately does not infer units from amount magnitude.

WITH financial_rows(table_name, record_id, financial_unit_status) AS (
  SELECT 'Technician', id, financialUnitStatus FROM "Technician"
  UNION ALL SELECT 'Job', id, financialUnitStatus FROM "Job"
  UNION ALL SELECT 'Part', id, financialUnitStatus FROM "Part"
  UNION ALL SELECT 'Invoice', id, financialUnitStatus FROM "Invoice"
  UNION ALL SELECT 'Payment', id, financialUnitStatus FROM "Payment"
  UNION ALL SELECT 'ServiceCategory', id, financialUnitStatus FROM "ServiceCategory"
  UNION ALL SELECT 'Referral', id, financialUnitStatus FROM "Referral"
  UNION ALL SELECT 'InsurancePolicy', id, financialUnitStatus FROM "InsurancePolicy"
  UNION ALL SELECT 'InsuranceClaim', id, financialUnitStatus FROM "InsuranceClaim"
  UNION ALL SELECT 'Wallet', id, financialUnitStatus FROM "Wallet"
  UNION ALL SELECT 'WalletTransaction', id, financialUnitStatus FROM "WalletTransaction"
  UNION ALL SELECT 'WithdrawalRequest', id, financialUnitStatus FROM "WithdrawalRequest"
  UNION ALL SELECT 'VipPlan', id, financialUnitStatus FROM "VipPlan"
  UNION ALL SELECT 'PaymentGatewayLog', id, financialUnitStatus FROM "PaymentGatewayLog"
  UNION ALL SELECT 'WalletLedger', id, financialUnitStatus FROM "WalletLedger"
  UNION ALL SELECT 'ServicePackage', id, financialUnitStatus FROM "ServicePackage"
  UNION ALL SELECT 'CustomerApproval', id, financialUnitStatus FROM "CustomerApproval"
  UNION ALL SELECT 'PartUsage', id, financialUnitStatus FROM "PartUsage"
  UNION ALL SELECT 'PricingSnapshot', id, financialUnitStatus FROM "PricingSnapshot"
)
SELECT
  table_name,
  COALESCE(financial_unit_status, '<NULL>') AS financial_unit_status,
  COUNT(*) AS record_count
FROM financial_rows
GROUP BY table_name, COALESCE(financial_unit_status, '<NULL>')
ORDER BY table_name, financial_unit_status;

-- Currency/attestation contradictions: these records claim VERIFIED_IRR
-- while their explicit currency column is not IRR (including NULL).
WITH currency_rows(table_name, record_id, financial_unit_status, currency) AS (
  SELECT 'Invoice', id, financialUnitStatus, currency FROM "Invoice"
  UNION ALL SELECT 'Payment', id, financialUnitStatus, currency FROM "Payment"
  UNION ALL SELECT 'PaymentGatewayLog', id, financialUnitStatus, currency FROM "PaymentGatewayLog"
)
SELECT
  table_name,
  COUNT(*) AS contradictory_verified_records
FROM currency_rows
WHERE financial_unit_status = 'VERIFIED_IRR'
  AND (currency IS NULL OR currency <> 'IRR')
GROUP BY table_name
ORDER BY table_name;

-- Do not use this inventory alone to promote records to VERIFIED_IRR.
-- Promotion requires row-level source evidence, exact unit, safe integer
-- validation, owner-approved policy where relevant, and reviewed reconciliation.
