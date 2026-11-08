# Payment outbox dispatcher (VIP simulator scope)

## What this worker does
- Polls the durable `PaymentOutboxEvent` table every five minutes through a Cloudflare Cron Trigger.
- Claims at most 25 events per invocation. A claim increments `attempts`, sets `PROCESSING`, and records a lease timestamp.
- Reclaims abandoned `PROCESSING` rows after a five-minute lease expires.
- Currently accepts only `PAYMENT_SUCCEEDED` events for the `Payment` aggregate whose server-authored payload purpose is `vip`. Other event types/purposes fail closed and eventually become `DEAD`.
- Verifies the persisted Payment, gateway attempt, IRR provenance, amount, user, target VIP plan, and active verified plan before fulfillment.
- Creates one VIP subscription and cancels the user's previous active VIP subscription in the same D1 batch that marks the outbox event `PROCESSED`.
- Uses `UserVipSubscription.paymentId` as the unique fulfillment key. A retry that finds the exact same user/plan/payment subscription only marks the event processed; conflicting bindings are rejected.
- Retries failures with exponential backoff (30 seconds base, capped at six hours), and moves events to `DEAD` after eight claims. The bounded error code is retained in `lastError`.

## Atomicity and concurrency
- Claiming is a conditional update: only one worker can move a due or expired-lease event to the current lease.
- The D1 fulfillment batch includes previous-subscription cancellation, the guarded subscription insert, event completion, and a SQL assertion. A failed insert/assertion rolls the entire batch back.
- If a worker crashes after claiming, another run may reclaim the row after lease expiry.
- If a worker crashes after successful fulfillment, the event and subscription are already committed together. A retry recognizes the existing exact payment binding and does not create a second subscription.
- The existing `/api/vip/subscribe` endpoint remains compatible: it returns the same subscription on exact replay. Whichever path fulfills first wins through the unique `paymentId` constraint; the other path recovers the same result.

## Staging-only deployment
1. Create a dedicated isolated staging D1 database. Do not point this worker at the production application database.
2. Replace the all-zero `database_id` and staging `database_name` in `wrangler.payment-outbox.toml`.
3. Verify the Cloudflare account with `bunx wrangler whoami`.
4. Confirm that the staging database has the current Prisma SQLite/D1 migrations applied, including `PaymentOutboxEvent`, `PaymentGatewayLog.targetPlanId`, `Payment.gatewayLogId`, `VipPlan`, and `UserVipSubscription`.
5. Deploy only after a separate explicit staging approval: `bun run deploy:payment-outbox:staging`.
6. Confirm the Cron Trigger is `*/5 * * * *`, the DB binding points only to staging, and logs show processed/failed/dead counts.
7. Seed synthetic staging-only payment, gateway, plan, and outbox rows; verify one ACTIVE subscription, prior ACTIVE subscription cancellation, one PROCESSED event, and no duplicate subscription after replay.
8. Remove all synthetic rows and retain test evidence.

## Explicit limitations
- This is a staging implementation for the current VIP simulator event only. It is not a live payment provider integration.
- It does not send email/SMS/push notifications or make external financial transfers.
- No production Worker, production D1 binding, provider credentials, real settlement, refund, or payout is configured or deployed.
- Operational alerting, operator-driven dead-letter replay UI, and reconciliation dashboards remain future work.
