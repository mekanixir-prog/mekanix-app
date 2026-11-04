-- STAGING ONLY. Run only against the isolated mekanix-wallet-escrow-staging D1 database.
-- Recreates one synthetic matured escrow row and resets the worker cursor.
DELETE FROM "WalletReleaseGuard" WHERE "id" LIKE 'wallet-release-assert:%';

DELETE FROM "WalletLedger" WHERE "idempotencyKey" LIKE 'wallet-release-staging:%';
DELETE FROM "WalletLedger" WHERE "idempotencyKey" = 'wallet-release:wallet-release-staging-txn:LEDGER';
DELETE FROM "WalletTransaction" WHERE "id" = 'wallet-release-staging-txn';
DELETE FROM "Wallet" WHERE "id" = 'wallet-release-staging-wallet';
DELETE FROM "Technician" WHERE "id" = 'wallet-release-staging-tech';
DELETE FROM "User" WHERE "id" = 'wallet-release-staging-user';
DELETE FROM "WalletReleaseWorkerState" WHERE "id" = 'wallet-release';

INSERT INTO "User"
  ("id", "name", "role", "status", "country", "currency", "language", "createdAt", "updatedAt")
VALUES
  ('wallet-release-staging-user', 'MEKANIX Staging Escrow Fixture', 'TECHNICIAN',
   'ACTIVE', 'IR', 'IRR', 'fa', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Technician" ("id", "userId", "createdAt", "updatedAt")
VALUES ('wallet-release-staging-tech', 'wallet-release-staging-user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "Wallet"
  ("id", "technicianId", "financialUnitStatus", "balance", "pendingBalance", "totalEarned", "totalCommission",
   "totalWithdrawn", "createdAt", "updatedAt")
VALUES
  ('wallet-release-staging-wallet', 'wallet-release-staging-tech', 'VERIFIED_IRR', 0, 10000, 10000, 0,
   0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "WalletTransaction"
  ("id", "walletId", "kind", "status", "grossAmount", "commissionAmount", "netAmount",
   "holdUntil", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
VALUES
  ('wallet-release-staging-txn', 'wallet-release-staging-wallet', 'PREPAY', 'PENDING',
   10000, 0, 10000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'),
   'Synthetic staging-only escrow release fixture',
   'wallet-release-staging:wallet-release-staging-txn', CURRENT_TIMESTAMP);

INSERT INTO "WalletLedger"
  ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
   "referenceType", "referenceId", "description", "idempotencyKey", "financialUnitStatus", "createdAt")
VALUES
  ('wallet-release-staging-hold-ledger', 'wallet-release-staging-wallet', 'HOLD',
   10000, 0, 10000, 'WalletTransaction', 'wallet-release-staging-txn',
   'Synthetic staging-only escrow hold',
   'wallet-release-staging:wallet-release-staging-txn:HOLD', CURRENT_TIMESTAMP);
