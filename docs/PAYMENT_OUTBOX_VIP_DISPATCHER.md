# Payment outbox dispatcher (VIP simulator scope)

## What this worker does
- Polls the durable `PaymentOutboxEvent` table every five minutes through a Cloudflare Cron Trigger.
- Claims at most 25 events per invocation. A claim increments `attempts`, sets `PROCESSING`, and records a lease timestamp.
- Reclaims abandoned `PROCESSING` rows after a five-minute lease expires.
- Currently accepts only `PAYMENT_SUCCEEDED` events for the `Payment` aggregate whose server-authored payload purpose is `vip`. Other event types/purposes fail closed and eventually become `DEAD`.
- Verifies the persisted Payment, gateway attempt, IRR provenance, amount, user, target VIP plan, and immutable purchase-time duration snapshot before fulfillment.
- Creates one VIP subscription and cancels the user's previous active VIP subscription in the same D1 batch that marks the outbox event `PROCESSED`.
- Uses `UserVipSubscription.paymentId` as the unique fulfillment key. A retry that finds the exact same user/plan/payment subscription only marks the event processed; conflicting bindings are rejected.
- Uses `PaymentGatewayLog.targetPlanDurationDays`, captured at payment initiation and copied into the outbox payload, to calculate expiry. Later edits or deactivation of `VipPlan` cannot change an already-paid entitlement. The Worker checks the event duration against the gateway-log snapshot and verifies that an existing subscription spans exactly that duration before completing a replay. Legacy gateway attempts without this snapshot are rejected for automatic activation and require reconciliation.
- Creates a deterministic `Notification` with ID `vip-activated:<paymentId>` in the same fulfillment batch. The API path uses the same ID, so an API/Worker race or retry cannot create duplicate activation notices; a crash after subscription creation can be recovered by the Worker.
- Retries failures with exponential backoff (30 seconds base, capped at six hours), and moves events to `DEAD` after eight claims. The bounded error code is retained in `lastError`.

## Atomicity and concurrency
- Claiming is a conditional update: only one worker can move a due or expired-lease event to the current lease.
- The D1 fulfillment batch includes previous-subscription cancellation, the guarded subscription insert, deterministic activation notice, event completion, and a SQL assertion. A failed insert/assertion rolls the entire batch back.
- If a worker crashes after claiming, another run may reclaim the row after lease expiry.
- If a worker crashes after successful fulfillment, the event and subscription are already committed together. A retry recognizes the existing exact payment binding and does not create a second subscription.
- The existing `/api/vip/subscribe` endpoint remains compatible: it returns the same subscription on exact replay. Whichever path fulfills first wins through the unique `paymentId` constraint; the other path recovers the same result.
- The Worker explicitly excludes the current `paymentId` when retiring previous active subscriptions. This prevents a subscription created by `/api/vip/subscribe` between the Worker's initial lookup and its D1 batch from being cancelled by that same batch.
- An integration test injects that API-created subscription at the read/batch boundary and verifies that it remains ACTIVE, the older subscription is cancelled, and the outbox event is processed exactly once.

## CI validation
- The Cloudflare workflow runs a Wrangler `deploy --dry-run` build for this Worker whenever its source, config, integration test, or runbook changes. This compiles/validates the dedicated Worker bundle without publishing it.
- The normal application OpenNext build and the payment outbox Worker dry-run are separate checks; one does not substitute for the other.

## Staging-only deployment
1. Create a dedicated isolated staging D1 database. Do not point this worker at the production application database.
2. Replace the all-zero `database_id` and staging `database_name` in `wrangler.payment-outbox.toml`.
3. Verify the Cloudflare account with `bunx wrangler whoami`.
4. Confirm that the staging database has the current Prisma SQLite/D1 migrations applied, including `PaymentOutboxEvent`, `PaymentGatewayLog.targetPlanId`, `PaymentGatewayLog.targetPlanDurationDays`, `Payment.gatewayLogId`, `VipPlan`, `UserVipSubscription`, and `Notification`.
5. Deploy only after a separate explicit staging approval: `bun run deploy:payment-outbox:staging`.
6. Confirm the Cron Trigger is `*/5 * * * *`, the DB binding points only to staging, and logs show processed/failed/dead counts.
7. Seed synthetic staging-only payment, gateway, plan, and outbox rows; verify one ACTIVE subscription, prior ACTIVE subscription cancellation, one PROCESSED event, and no duplicate subscription after replay.
8. Remove all synthetic rows and retain test evidence.

## Purchase snapshot and legacy handling
- New gateway attempts persist `targetPlanDurationDays` at initiation. Verification copies it into the durable event payload; both the synchronous API and scheduled Worker use that exact value.
- The migration leaves this field nullable for historical rows. Do not backfill from the current plan duration: that would fabricate historical purchase terms. Historical attempts with a missing snapshot must be reconciled manually before entitlement activation.
- Notification identity is deterministic (`vip-activated:<paymentId>`). If a historical API-generated notification used a random ID, a replay may create one deterministic notification in addition to that legacy notice; do not delete historical notifications automatically.

## Explicit limitations
- This is a staging implementation for the current VIP simulator event only. It is not a live payment provider integration.
- It does not send email/SMS/push notifications or make external financial transfers.
- No production Worker, production D1 binding, provider credentials, real settlement, refund, or payout is configured or deployed.
- Operational alerting, operator-driven dead-letter replay UI, and reconciliation dashboards remain future work.
