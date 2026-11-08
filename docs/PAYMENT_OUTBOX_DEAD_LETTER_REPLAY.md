# Payment outbox dead-letter replay — safety specification

**Status:** design only. No replay endpoint, mutation control, or worker behavior is enabled by this document.

## Objective

Allow a tightly authorized operator to request one new processing cycle for a terminal \`DEAD\` VIP payment event after the underlying cause has been investigated and corrected. The scheduled Worker remains the only component that fulfills the entitlement. The admin API must never create a subscription, mark an event processed, alter the payload, or call the fulfillment routine directly.

## Non-negotiable invariants

1. **The payment remains the source of truth.** Replay is not proof of payment and cannot change \`Payment\`, \`PaymentGatewayLog\`, amount, currency, gateway status, financial provenance, target plan, or purchase-time duration.
2. **The Worker remains the sole fulfiller.** The replay action only makes a validated event eligible for a fresh Worker claim.
3. **No payload editing.** The persisted server-authored JSON payload and \`idempotencyKey\` are immutable during replay.
4. **No duplicate entitlement.** \`UserVipSubscription.paymentId\` remains the fulfillment idempotency key. An exact existing subscription may be reconciled by the Worker; a conflicting binding blocks replay.
5. **Auditing and queue transition are atomic.** The durable audit record and \`DEAD → PENDING\` transition must commit together. If the active SQLite/D1 adapter cannot guarantee this transaction, do not ship the mutation endpoint.
6. **Compare-and-swap only.** The transition must include \`id\`, \`status='DEAD'\`, \`eventType\`, \`aggregateType\`, and the previously-read \`idempotencyKey\` in its update predicate. A second operator or concurrent process must receive a conflict, not overwrite the winner.
7. **No merge or deployment is implied.** This specification is not authorization to enable replay in staging or production.

## Authorization and request contract

- Require a valid admin session and same-origin/CSRF validation for cookie-authenticated requests.
- Require \`SUPER_ADMIN\` for this financial operation. A regular \`ADMIN\` session is insufficient. The current in-app bearer path only returns \`ADMIN\`, so it must remain read-only for replay.
- Accept only an event ID, a human-entered reason, and an explicit confirmation value. Never accept a payload, payment ID, gateway ID, amount, plan, duration, status, or idempotency key from the client.
- Require a non-empty reason of 20–500 characters after trimming. Store the reason in the audit record; do not put it in \`lastError\`.
- Require the operator to confirm the exact event ID in the UI before submission. This is an accidental-action guard, not an authorization mechanism.
- Rate-limit replay attempts per operator and event; the exact policy and storage mechanism must be decided before implementation.

## Eligibility checks (server-side, immediately before the transition)

The server must load the outbox row and its linked financial records from the database, then reject unless every condition below is true:

- Outbox status is exactly \`DEAD\`.
- \`eventType='PAYMENT_SUCCEEDED'\` and \`aggregateType='Payment'\`.
- JSON payload parses and passes the same strict schema validation as the Worker.
- \`payload.paymentId === aggregateId\`.
- \`idempotencyKey === 'payment.succeeded:' + payload.gatewayLogId\`.
- Payload purpose is exactly \`vip\`, currency is \`IRR\`, amount is a positive safe integer, and duration is a positive safe integer within the Worker limit.
- Persisted \`Payment\` exists and matches the payload user, amount, and gateway log; it is \`SUCCEEDED\` and \`VERIFIED_IRR\`.
- Persisted \`PaymentGatewayLog\` exists, belongs to that Payment, is \`VERIFIED\`, has purpose \`vip\`, and matches amount, currency, target plan, and \`targetPlanDurationDays\` exactly.
- The target \`VipPlan\` row still exists. Its current active flag or current price must not rewrite the already-verified purchase snapshot.
- If a \`UserVipSubscription\` already exists for the payment, its user, plan, and exact start-to-expiry duration must match the payload. A mismatch is a hard conflict and must never be repaired by replay.
- A payment that is \`REFUNDED\`, not \`SUCCEEDED\`, or lacks verified financial provenance is never eligible.
- Legacy attempts without \`targetPlanDurationDays\` are not eligible for automatic replay. They require manual financial reconciliation; do not infer the duration from the current plan.

Any unsupported event type, unknown purpose, malformed payload, missing record, or mismatch fails closed.

## State transition and attempt accounting

- Add explicit replay metadata before enabling the endpoint: a monotonic replay counter and last replay timestamp/operator reference. Keep \`attempts\` as the number of claims in the current processing cycle; do not silently erase historical retry information.
- Preserve the previous \`lastError\` in the audit snapshot before clearing it for the new cycle.
- On an eligible request, atomically:
  1. insert a durable audit entry containing operator identity, reason, event ID, old status/attempts/error, validated payment/gateway binding identifiers, and the intended transition;
  2. increment replay metadata;
  3. set status to \`PENDING\`, reset cycle attempts to zero, set \`availableAt\` to the transaction timestamp, clear \`lockedAt\` and \`processedAt\`, clear the active \`lastError\`, and update the timestamp.
- Do not alter \`payload\`, \`idempotencyKey\`, \`eventType\`, \`aggregateType\`, or \`aggregateId\`.
- Use a conditional update and require exactly one affected row. A zero-row result is a \`409\` conflict.
- Return \`202 Accepted\` with a replay-request identifier and the new queue state. Do not claim that the VIP subscription is active; only the Worker can establish that.
- The Worker then revalidates all payment facts and performs its existing atomic fulfillment batch. A subsequent \`DEAD\` outcome is possible and must remain visible.

## API response and error behavior

Suggested route: \`POST /api/admin-panel/payment-outbox/:id/replay\`.

- \`400\`: malformed body, missing/short/long reason, or confirmation mismatch.
- \`401\`: no valid admin session.
- \`403\`: wrong role or invalid same-origin/CSRF signal.
- \`404\`: event not found.
- \`409\`: event no longer \`DEAD\`, compare-and-swap lost, unsupported event, payment/subscription binding conflict, or failed eligibility check.
- \`429\`: operator/event replay rate limit reached.
- \`503\`: database or atomic audit/transition facility unavailable. No state change may occur.

Responses must use \`Cache-Control: no-store\` and must not return the payment payload, customer data, card data, or sensitive gateway response.

## UI behavior

- Keep the existing list read-only by default.
- Show a replay action only for \`DEAD\` rows and only to a \`SUPER_ADMIN\` session.
- The confirmation dialog must show the event ID, event type, amount-independent payment reference, attempt count, last error, and a required reason field. Never display raw payload.
- Require exact event-ID confirmation before enabling the final action.
- After \`202\`, show **Queued for reprocessing**, not **Paid**, **Activated**, or **Succeeded**.
- Refresh the event row and summary. Display replay count and last replay time/operator from server data.
- Never offer bulk replay, automatic replay of every \`DEAD\` row, payload editing, manual \`PROCESSED\` marking, or direct subscription creation.

## Required test matrix before implementation can be considered complete

### Authorization and request validation
- Unauthenticated, invalid cookie, stale session version, regular \`ADMIN\`, and cross-origin cookie request are rejected.
- \`SUPER_ADMIN\` with same-origin cookie succeeds only after all checks pass.
- Missing, blank, too-short, too-long reason and incorrect confirmation are rejected.
- Rate limit is enforced without changing event state.

### Eligibility and financial binding
- Wrong event type/aggregate, malformed JSON, mismatched aggregate ID, mismatched idempotency key, unsupported purpose, invalid amount/currency/duration all fail closed.
- Missing Payment, wrong user/amount/gateway link, non-SUCCEEDED or non-VERIFIED_IRR Payment all fail closed.
- Missing or non-VERIFIED gateway log, wrong purpose/amount/currency/plan/duration snapshot all fail closed.
- Missing plan, legacy null duration snapshot, refunded payment, and conflicting existing subscription all fail closed.
- Exact existing subscription is allowed only for Worker reconciliation and never causes a second subscription.

### Concurrency, atomicity, and worker behavior
- Two simultaneous replay requests produce exactly one queued transition and one conflict.
- If audit insertion fails, event remains \`DEAD\`.
- If event transition fails, the audit record and replay metadata roll back with it.
- A crash at every transaction boundary cannot leave an unaudited \`PENDING\` event.
- Worker retry produces at most one subscription and one deterministic activation notification.
- Worker revalidates payment/gateway facts after the admin request; changed/refunded financial state cannot be fulfilled.
- A replay that fails again can return to \`DEAD\` and be investigated again without losing the prior replay history.

## Rollout gates

1. Land the specification and review it with the payment/outbox implementation.
2. Implement replay metadata migrations for both SQLite/D1 and PostgreSQL, plus schema verification in CI.
3. Prove atomic audit + conditional state transition against both database paths; do not rely on an unverified Prisma transaction assumption.
4. Implement and test the server route before adding any UI control.
5. Add the \`SUPER_ADMIN\` UI confirmation flow only after route tests pass.
6. Keep the feature disabled in production until staging tests use synthetic verified payments and a separately approved staging deployment.
7. Review reconciliation, refunds/chargebacks, and operator incident procedures before any live payment provider is connected.
