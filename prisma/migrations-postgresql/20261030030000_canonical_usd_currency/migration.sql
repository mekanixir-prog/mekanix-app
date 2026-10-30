-- Canonical internal accounting currency is USD. UI converts USD to IRR for display.
-- Existing invoice/payment amounts were already USD base values; only their labels were wrong.
UPDATE "Invoice" SET "currency" = 'USD';
ALTER TABLE "Invoice" ALTER COLUMN "currency" SET DEFAULT 'USD';

UPDATE "Payment" SET "currency" = 'USD';
ALTER TABLE "Payment" ALTER COLUMN "currency" SET DEFAULT 'USD';

ALTER TABLE "VipPlan" RENAME COLUMN "priceIrr" TO "priceUsd";

ALTER TABLE "PaymentGatewayLog" ADD COLUMN "baseAmountUsd" DECIMAL;
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "exchangeRate" DECIMAL;

-- Prior simulator logs stored USD values while incorrectly labelling them IRR.
UPDATE "PaymentGatewayLog"
SET "baseAmountUsd" = "amount", "exchangeRate" = 1, "currency" = 'USD'
WHERE "baseAmountUsd" IS NULL;
