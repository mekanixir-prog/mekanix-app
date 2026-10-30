-- Canonical internal accounting currency is USD. UI converts USD to IRR for display.
-- Existing invoice/payment amounts were already USD base values; only their labels were wrong.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE "new_Invoice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "laborHours" REAL NOT NULL DEFAULT 1,
  "laborRate" DECIMAL NOT NULL DEFAULT 45,
  "laborTotal" DECIMAL NOT NULL DEFAULT 0,
  "partsTotal" DECIMAL NOT NULL DEFAULT 0,
  "travelFee" DECIMAL NOT NULL DEFAULT 0,
  "subtotal" DECIMAL NOT NULL DEFAULT 0,
  "taxRate" REAL NOT NULL DEFAULT 0.09,
  "taxTotal" DECIMAL NOT NULL DEFAULT 0,
  "discount" DECIMAL NOT NULL DEFAULT 0,
  "total" DECIMAL NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Invoice_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Invoice" (
  "id", "code", "jobId", "laborHours", "laborRate", "laborTotal", "partsTotal",
  "travelFee", "subtotal", "taxRate", "taxTotal", "discount", "total", "currency",
  "notes", "status", "createdAt", "updatedAt"
)
SELECT
  "id", "code", "jobId", "laborHours", "laborRate", "laborTotal", "partsTotal",
  "travelFee", "subtotal", "taxRate", "taxTotal", "discount", "total", 'USD',
  "notes", "status", "createdAt", "updatedAt"
FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";
CREATE UNIQUE INDEX "Invoice_code_key" ON "Invoice"("code");
CREATE UNIQUE INDEX "Invoice_jobId_key" ON "Invoice"("jobId");

CREATE TABLE "new_Payment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "invoiceId" TEXT,
  "userId" TEXT NOT NULL,
  "amount" DECIMAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "method" TEXT NOT NULL DEFAULT 'card',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "gatewayLogId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Payment" (
  "id", "code", "invoiceId", "userId", "amount", "currency", "method",
  "status", "gatewayLogId", "createdAt"
)
SELECT
  "id", "code", "invoiceId", "userId", "amount", 'USD', "method",
  "status", "gatewayLogId", "createdAt"
FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_code_key" ON "Payment"("code");
CREATE UNIQUE INDEX "Payment_invoiceId_key" ON "Payment"("invoiceId");
CREATE UNIQUE INDEX "Payment_gatewayLogId_key" ON "Payment"("gatewayLogId");

ALTER TABLE "VipPlan" RENAME COLUMN "priceIrr" TO "priceUsd";
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "baseAmountUsd" DECIMAL;
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "exchangeRate" DECIMAL;

-- Prior simulator logs stored USD values while incorrectly labelling them IRR.
UPDATE "PaymentGatewayLog"
SET "baseAmountUsd" = "amount", "exchangeRate" = 1, "currency" = 'USD'
WHERE "baseAmountUsd" IS NULL;

COMMIT;
PRAGMA foreign_keys=ON;
