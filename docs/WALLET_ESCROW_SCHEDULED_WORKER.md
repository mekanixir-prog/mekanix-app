# Scheduled wallet escrow release

## Purpose

The dedicated Worker is intended to release matured wallet escrow every 15 minutes. The production application currently **does not release escrow from wallet GET requests**: `shouldUseLegacyWalletReleaseFallback` always returns false when `NODE_ENV=production`, regardless of `WALLET_RELEASE_SCHEDULED`. The committed Worker configuration is staging-only and contains a placeholder D1 ID. Therefore, until a separately configured production Worker is deployed and verified, matured production escrow transactions can remain `PENDING`.

This is an intentional fail-closed financial safety posture. Do not re-enable GET-triggered financial writes as a workaround. Wallet reads must remain read-only with respect to escrow release.

## Deployment order

1. The atomic escrow-release base implementation (PR #12) is already merged into mainline.
2. Create a **separate isolated staging D1 database**. Do not reuse the application production D1 database for the first deployment or validation.
3. Replace the all-zero `database_id` placeholder in `wrangler.wallet-release.toml` with the staging database ID, and set `database_name` to the exact staging database name. The committed config intentionally cannot deploy until this staging-only step is completed.
4. The Worker config points Wrangler's D1 migration runner at the nested Prisma SQLite history (`prisma/migrations/*/migration.sql`). First inspect the pending migration list, then apply only to the isolated staging database. The command is remote and mutates that D1 database, so do not run it until the database name/ID and Cloudflare account are independently confirmed:

   ```bash
   bunx wrangler d1 migrations list mekanix-wallet-escrow-staging --remote --config wrangler.wallet-release.toml
   bunx wrangler d1 migrations apply mekanix-wallet-escrow-staging --remote --config wrangler.wallet-release.toml
   bunx wrangler d1 migrations list mekanix-wallet-escrow-staging --remote --config wrangler.wallet-release.toml
   ```

   Confirm there are no unapplied migrations and verify the hold-scan index (`20261101020000_wallet_hold_scan_index`) and durable cursor table (`WalletReleaseWorkerState`) before deploying the Worker. Wrangler supports nested migration patterns via `migrations_dir` and `migrations_pattern`; CI applies this same history to a local D1 database before building the Worker.
5. Deploy the staging Worker from the repository root:

   `bun run deploy:wallet-release:staging`

6. In Cloudflare, verify that the staging Worker `mekanix-wallet-escrow-release` has the Cron Trigger `*/15 * * * *` and is bound only to the isolated staging D1 database.
7. Verify the active Cloudflare account before seeding a synthetic staging-only escrow row. The fixture wrapper refuses to run unless the config names the staging database, the configured D1 ID matches an explicit environment variable, and the operator opts in:

   ```bash
   bunx wrangler whoami
   export WALLET_RELEASE_STAGING_DATABASE_ID="<exact staging D1 database ID>"
   export ALLOW_WALLET_RELEASE_STAGING_FIXTURE=YES
   bash scripts/wallet-release-staging-fixture.sh seed
   ```

   Wait for the next 15-minute Cron execution. Inspect Worker logs for `[wallet-escrow-release] run complete`. Confirm the JSON log fields are `scanned: 1`, `released: 1`, and `failed: 0` for the synthetic row. Verify the resulting state:

   ```bash
   bunx wrangler d1 execute mekanix-wallet-escrow-staging --remote --config wrangler.wallet-release.toml \
     --command "SELECT wt.status, w.balance, w.pendingBalance, (SELECT COUNT(*) FROM WalletLedger l WHERE l.idempotencyKey='wallet-release:wallet-release-staging-txn:LEDGER') AS release_ledger_count FROM WalletTransaction wt JOIN Wallet w ON w.id=wt.walletId WHERE wt.id='wallet-release-staging-txn';"
   ```

   Expected: `AVAILABLE`, balance `10000`, pending balance `0`, and exactly one RELEASE ledger row. Remove the synthetic user, technician, wallet, transaction, ledger rows, and cursor after capturing evidence:

   ```bash
   bash scripts/wallet-release-staging-fixture.sh cleanup
   ```

   This fixture is synthetic and does not initiate a payment, payout, or bank transfer.
8. Production rollout is a separate, currently incomplete release task. It requires a production-specific Worker config bound to the exact production D1 database, independent Cloudflare account/database verification, a backup and restore plan, an approved migration review, a controlled rollout, and monitoring evidence. Do not copy a staging ID into production or reuse the committed staging config.
9. The application currently has no production GET fallback to keep enabled or disable: the policy always returns false in production. `WALLET_RELEASE_SCHEDULED` does not change that production behavior. Do not change this policy or enable GET-triggered financial writes as a substitute for the scheduled Worker.

## Processing behavior

- Each scheduled run scans matured PENDING transactions in keyset-paginated pages of 100, up to 1,000 per run. Ordering is by `holdUntil` and `id`. The last cursor is persisted in `WalletReleaseWorkerState`, so a permanently failing early row cannot pin every later Cron run to the first 1,000 rows. When the end of the current keyset cycle is reached, the cursor is reset so still-pending failures and newly matured rows are revisited on the next run.
- The cursor table is created by the paired SQLite/D1 and PostgreSQL migration `20261101030000_wallet_release_worker_cursor`. It stores only the worker's pagination position and update time; it contains no customer or financial payload data.
- A crash after a page is processed but before its cursor is saved may cause that page to be scanned again. The atomic release helper is idempotent: an already AVAILABLE transaction does not transfer the balance a second time.
- Each release uses the same atomic D1 batch helper as the application path. A transaction is changed to AVAILABLE only when its matching wallet pending-to-available balance transfer succeeds, and the same transaction writes a unique `WalletLedger` `RELEASE` proof row. The helper now asserts exactly one changed row after the wallet update, transaction transition, and ledger insert; a zero-row statement is converted into a SQL error so D1 rolls back the entire batch. Duplicate ledger keys, failed inserts, and silently ignored writes cannot leave a partial transfer.
- SQLite integration tests cover both hard SQL errors and `RAISE(IGNORE)` zero-row behavior for transaction and ledger steps, asserting that wallet balances, transaction status, and ledger rows all remain unchanged after rollback.
- One failed transaction is logged and does not prevent later due entries from being attempted. A permanently inconsistent row is retried on later cron runs and remains visible in `failed`/`unchanged` telemetry; operational reconciliation is still required.
- The worker exposes no public HTTP action; fetch requests return 404.
- This worker does not call a bank or payment provider.

## Validation still required

- Run a real isolated D1 integration test before production rollout.
- Confirm Cron Trigger execution and D1 binding in the target Cloudflare account.
- Monitor failed counts and compare matured PENDING rows with released AVAILABLE rows during a controlled rollout.
- Until the production Worker is deployed and observed, track matured production `PENDING` escrow rows as a release blocker and reconcile them operationally. Do not assume that the staging Worker or CI build provides production coverage.

No production Worker was deployed and no production environment variable was changed while preparing this change.
