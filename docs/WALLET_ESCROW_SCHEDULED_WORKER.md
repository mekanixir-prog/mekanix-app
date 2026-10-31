# Scheduled wallet escrow release

## Purpose

Wallet escrow is currently released when the technician wallet is read. That makes a GET request perform financial writes and means a matured hold can remain pending if nobody opens the wallet. This dedicated Worker moves the release job to a 15-minute Cloudflare Cron Trigger.

## Deployment order

1. Merge the atomic escrow-release implementation (PR #12) first.
2. Create a **separate isolated staging D1 database**. Do not reuse the application production D1 database for the first deployment or validation.
3. Replace the all-zero `database_id` placeholder in `wrangler.wallet-release.toml` with the staging database ID, and set `database_name` to the exact staging database name. The committed config intentionally cannot deploy until this staging-only step is completed.
4. Apply the reviewed SQLite/D1 migration history to that staging database and verify the new hold-scan index before deploying the Worker.
5. Deploy the staging Worker from the repository root:

   `bun run deploy:wallet-release:staging`

6. In Cloudflare, verify that the staging Worker `mekanix-wallet-escrow-release` has the Cron Trigger `*/15 * * * *` and is bound only to the isolated staging D1 database.
7. Inspect Worker logs for `[wallet-escrow-release] run complete`. Confirm that scanned/released/failed counts are plausible and compare wallet balances against the ledger.
8. Keep `WALLET_RELEASE_SCHEDULED` unset in production. Production Worker configuration and rollout require a separate launch change, explicit target-account verification, backup, and approval; do not copy a staging ID into production or reuse the committed staging config.
9. Keep the GET fallback enabled until a separately approved production scheduled Worker has been deployed and observed successfully. Do not set the variable early.

## Processing behavior

- Each scheduled run scans matured PENDING transactions in keyset-paginated pages of 100, up to 1,000 per run. Ordering is by `holdUntil` and `id`; a failed early row cannot prevent later rows in the same run from being attempted. If the 1,000-row cap is reached, the next cron run continues from the oldest still-pending rows.
- Each release uses the same atomic D1 batch helper as the application path. A transaction is changed to AVAILABLE only when its matching wallet pending-to-available balance transfer succeeds.
- One failed transaction is logged and does not prevent later due entries from being attempted. A permanently inconsistent row is retried on later cron runs and remains visible in `failed`/`unchanged` telemetry; operational reconciliation is still required.
- The worker exposes no public HTTP action; fetch requests return 404.
- This worker does not call a bank or payment provider.

## Validation still required

- Run a real isolated D1 integration test before production rollout.
- Confirm Cron Trigger execution and D1 binding in the target Cloudflare account.
- Monitor failed counts and compare matured PENDING rows with released AVAILABLE rows during a controlled rollout.

No production Worker was deployed and no production environment variable was changed while preparing this change.
