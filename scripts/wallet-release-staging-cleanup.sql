-- STAGING ONLY. Removes only the synthetic fixture created by the paired seed script.
DELETE FROM "WalletLedger" WHERE "idempotencyKey" LIKE 'wallet-release-staging:%';
DELETE FROM "WalletLedger" WHERE "idempotencyKey" = 'wallet-release:wallet-release-staging-txn:LEDGER';
DELETE FROM "WalletTransaction" WHERE "id" = 'wallet-release-staging-txn';
DELETE FROM "Wallet" WHERE "id" = 'wallet-release-staging-wallet';
DELETE FROM "Technician" WHERE "id" = 'wallet-release-staging-tech';
DELETE FROM "User" WHERE "id" = 'wallet-release-staging-user';
DELETE FROM "WalletReleaseWorkerState" WHERE "id" = 'wallet-release';
