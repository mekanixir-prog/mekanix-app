# Scheduled wallet escrow release

## Purpose

Wallet escrow is currently released when the technician wallet is read. That makes a GET request perform financial writes and means a matured hold can remain pending if nobody opens the wallet. This dedicated Worker moves the release job to a 15-minute Cloudflare Cron Trigger.

## Deployment order

1. Merge the atomic escrow-release implementation (PR #12) first.
2. Deploy the dedicated worker from the repository root:

   `bunx wrangler deploy --config wrangler.wallet-release.toml`

3. In Cloudflare, verify that the Worker `mekanix-wallet-escrow-release` has the Cron Trigger `*/15 * * * *` and is bound to the existing `mekanix` D1 database.
4. Inspect Worker logs for `[wallet-escrow-release] run complete`. Confirm that scanned/released/failed counts are plausible.
5. Only after at least one successful scheduled run, set `WALLET_RELEASE_SCHEDULED=true` on the main `mekanix` application Worker and deploy that configuration. This disables the transitional GET fallback.
6. Keep the GET fallback enabled until the scheduled Worker has been deployed and observed successfully. Do not set the variable early.

## Processing behavior

- Each scheduled run scans at most 100 matured PENDING transactions ordered by hold time. Remaining entries are handled by later runs.
- Each release uses the same atomic D1 batch helper as the application path. A transaction is changed to AVAILABLE only when its matching wallet pending-to-available balance transfer succeeds.
- One failed transaction is logged and does not prevent later due entries from being attempted.
- The worker exposes no public HTTP action; fetch requests return 404.
- This worker does not call a bank or payment provider.

## Validation still required

- Run a real isolated D1 integration test before production rollout.
- Confirm Cron Trigger execution and D1 binding in the target Cloudflare account.
- Monitor failed counts and compare matured PENDING rows with released AVAILABLE rows during a controlled rollout.

No production Worker was deployed and no production environment variable was changed while preparing this change.
