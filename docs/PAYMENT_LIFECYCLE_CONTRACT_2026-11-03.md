# MEKANIX — Payment Lifecycle Contract (Pre-Implementation Design)

**Status:** Design proposal; not an implementation approval  
**Reviewed main baseline:** `63095f5daffbe950ef707e2a0521b8ffd28a22c1`  
**Related blockers:** [Issue #24](https://github.com/mekanixir-prog/mekanix-app/issues/24), [Issue #81](https://github.com/mekanixir-prog/mekanix-app/issues/81)

> This document defines the engineering sequence and safety invariants for a future payment lifecycle. It does not approve a canonical monetary unit, tariffs, conversion rules, provider activation, or historical-data migration. No live payment or production money movement is authorized.

## 1. Verified current-state facts

The reviewed main branch currently has:

- `Payment` with optional unique `invoiceId`, `userId`, `amount`, `currency`, `status`, and optional unique `gatewayLogId`.
- `PaymentGatewayLog` with a unique human-facing `code`, owner, amount/currency, gateway, status, reference, callback payload, timestamps and a non-relational `paymentId` string.
- No first-class persisted payment-attempt model binding one internal order to a purpose, target business record, provider request, provider authority, verification result and fulfillment state.
- `src/lib/payment-provider.ts` contains Zarinpal/IDPay adapter scaffolding, but the production payment routes do not call it. Its readiness helper correctly reports `integrationWired: false`.
- `POST /api/payments`, `POST /api/gateway/initiate`, and `POST /api/gateway/verify` are simulator routes and return 404 in production. The simulator must remain unavailable in production.
- The current invoice simulator can mark an invoice PAID, complete its Job and create a warranty, but does not create the technician's commission/net escrow transaction and matching wallet ledger entries.
- The current provider adapter hardening work is in Draft PR #66. It is not a completed payment lifecycle.

These are code observations, not a claim that existing persisted financial amounts have a verified unit.

## 2. Non-negotiable invariants

1. **Server-owned amount:** clients submit a business target and an idempotency key, never the payable amount, currency, success status, provider reference, or fulfillment result.
2. **Ownership:** the server resolves the authenticated payer and verifies ownership/permission for the target invoice, plan or booking before creating an attempt.
3. **Immutable order identity:** create a cryptographically unpredictable internal order/attempt ID before contacting a provider. Persist it and pass it unchanged to the adapter. Never generate a replacement order ID inside an adapter.
4. **Persist before redirect:** the attempt and its idempotency identity exist before the external provider request. A provider timeout must leave a recoverable state, not an untraceable payment.
5. **No long database transaction around network I/O:** persist a state transition, call the provider, then persist the result with compare-and-set. Never hold a database transaction open while waiting for a gateway.
6. **Callback is untrusted input:** browser redirect parameters, client OTP, client amount, client status and callback payload are signals only. The server must load the attempt and call the provider's server-side verification API.
7. **Exact match:** verified provider response must match the persisted attempt's provider, authority, internal order identity (where supported), exact provider amount and currency contract, and expected payer/merchant context. Any mismatch becomes a reviewable failure; it must not fulfill business state.
8. **Idempotent verification:** repeated or concurrent callbacks for one attempt produce one verified payment and one fulfillment effect. Database uniqueness and conditional transitions backstop application checks.
9. **Purpose-specific fulfillment:** invoice payment, VIP activation, prepay and wallet top-up are different business operations. A generic “payment succeeded” function must not guess what to activate or credit.
10. **Atomic fulfillment evidence:** the verified payment transition and a durable fulfillment/outbox record are committed atomically. A retry worker can safely finish incomplete fulfillment.
11. **Append-only financial evidence:** corrections/refunds use explicit compensating records and audited state transitions. Never rewrite a successful payment into a different amount or silently delete evidence.
12. **Fail closed:** unknown provider, missing credentials, ambiguous units, amount mismatch, stale callback, duplicate order, unavailable verification API, or incomplete fulfillment must not be reported as success.

## 3. Proposed lifecycle

The names below are a proposal for review, not existing enum values.

```text
CREATED
  -> INITIATION_PENDING
  -> REDIRECT_READY
  -> CALLBACK_RECEIVED
  -> VERIFYING
  -> VERIFIED
  -> FULFILLMENT_PENDING
  -> FULFILLED

Alternative terminal / review states:
INITIATION_FAILED | VERIFICATION_FAILED | EXPIRED | CANCELLED | REVIEW_REQUIRED
```

- Provider initiation failure is distinct from customer cancellation and verification failure.
- A callback arriving before the provider request result is persisted is reconciled by the immutable internal attempt ID and provider authority; it must not create a second attempt.
- A timeout after provider initiation is an unknown outcome. Reconciliation queries the provider using persisted identifiers; it must not create a new charge automatically.
- A late callback after expiry is verified against the original attempt. It is either accepted under a documented late-settlement policy or moved to manual review; it is never silently discarded or applied twice.
- A verified payment whose business fulfillment fails remains VERIFIED + FULFILLMENT_PENDING. Retrying fulfillment must not call the provider again.

## 4. Candidate persistence boundaries

Before schema work, agree the exact field contract and database portability. Candidate records:

### PaymentAttempt (candidate)

- Internal ID / immutable order ID with a database unique constraint.
- Authenticated payer ID.
- Purpose discriminator and target record ID (for example invoice ID, VIP plan/subscription request ID, or booking/prepay ID).
- Source amount and source-unit snapshot copied from the authoritative business record without reinterpretation.
- Provider name, provider authority, provider-facing amount/unit snapshot only after the monetary-unit contract is approved.
- Idempotency key and a request fingerprint; reusing a key with a different payer, purpose, target or payload returns conflict.
- Lifecycle status, created/updated/expiry timestamps, verified timestamp and normalized provider reference.
- Sanitized failure code and reconciliation metadata. Do not persist OTPs, PAN, CVV, secrets, or unnecessary raw callback data.

### Payment / existing records

- `Payment` remains the successful financial record only after server-side verification; it must be uniquely linked to the attempt.
- `PaymentGatewayLog` should either become an audit/event record with a real relation to the attempt or be retired after a reviewed compatibility migration. Avoid maintaining two competing sources of truth.
- Add database uniqueness for one successful fulfillment per attempt and, where applicable, one payment consumption per VIP subscription.
- Do not add or migrate amount fields until issue #81 establishes the unit and historical-value treatment.

### FulfillmentOutbox (candidate)

- Unique event key derived from payment-attempt ID + fulfillment purpose.
- Event type, target ID, payload version, retry count, next-attempt time, status, created/processed timestamps and a sanitized last error.
- Created in the same database transaction/batch that marks the attempt VERIFIED.
- Worker handlers are purpose-specific, compare-and-set target state, and are safe under duplicate delivery.

Prisma/PostgreSQL and Cloudflare D1 must implement equivalent uniqueness and atomicity semantics. The implementation must use the repository's tested database abstraction rather than assuming PostgreSQL-only transactions are available in Worker/D1 execution.

## 5. Purpose-specific fulfillment contracts

| Purpose | Preconditions | Successful fulfillment | Required idempotency guard |
|---|---|---|---|
| Invoice | Invoice exists, is payable, belongs to payer; payable amount is server-derived | Mark invoice paid; perform only valid job/warranty transition; create technician gross/commission/net escrow and ledger evidence according to an approved settlement policy | Unique payment-to-invoice relation; invoice compare-and-set; unique wallet transaction/ledger event key |
| VIP | Selected plan is active and its price/unit is verified; payer owns the checkout | Create or replace the subscription only after verified payment; do not extend/replace twice | Unique payment consumption and atomic subscription transition |
| Prepay | Booking/job and fee source are verified; prepay is actually required | Apply prepay to the correct booking/job and create only the explicitly approved wallet/escrow effects | Unique attempt-to-booking purpose key |
| Wallet top-up | Wallet owner and top-up policy are verified; this product flow is explicitly approved | Credit the intended wallet through immutable ledger entries | Unique top-up event key; never infer wallet top-up from a generic successful payment |

No commission percentage, release hold, refund policy, VIP entitlement, or price is approved by this design. Existing business rules must be audited and explicitly confirmed before implementation.

## 6. Endpoint/service responsibilities

- **Initiation endpoint:** authenticate; validate target and idempotency key; resolve amount from the server-side business record; check source-unit provenance; create attempt; call selected provider; persist provider authority/payment URL; return only the redirect result and opaque attempt reference.
- **Callback endpoint:** validate provider-specific callback shape and size; resolve attempt by persisted provider authority/internal order ID; record a callback-received signal; never trust callback status or amount.
- **Verification service:** load the immutable attempt; lock/claim it with a conditional state transition; call the provider's server-side verify API using persisted amount and identifiers; validate exact response; persist normalized verification result and Payment + outbox atomically.
- **Status endpoint:** expose only the authenticated owner's attempt status; never expose secrets or raw callback data.
- **Fulfillment worker:** process outbox events with bounded retries, idempotent handlers, dead-letter/manual-review state and auditable operator resolution.
- **Readiness endpoint:** report live-ready only when the selected adapter is implemented, required credentials are present, the lifecycle is wired, and required sandbox certification evidence is current. Environment selection alone is never readiness.

## 7. Required test matrix

### Initiation and ownership
- Unknown purpose/target, foreign-owned invoice, inactive VIP plan, already-paid invoice, invalid idempotency key.
- Client-supplied amount/currency/status ignored or rejected.
- Same idempotency key + same fingerprint returns the original attempt.
- Same key + different payer/purpose/target/fingerprint returns conflict.
- Provider timeout after request submission is recoverable without duplicate charge.

### Verification and callbacks
- Forged callback, invalid signature/token, wrong provider authority, wrong order ID, wrong payer/merchant, wrong amount/unit.
- Provider timeout/outage, malformed JSON, non-success provider code, missing tracking reference.
- Duplicate callback, concurrent callback, callback replay, out-of-order callback, late callback and callback after cancellation/expiry.
- Verification retry after provider accepted payment but application persistence failed.

### Fulfillment and accounting
- One invoice payment creates one Payment, one invoice transition, one warranty transition where applicable, and one approved technician escrow/ledger event.
- One VIP payment creates one subscription consumption.
- One prepay attempt affects only its target booking/job.
- Injected failure between verification and fulfillment is recovered by outbox retry without another provider charge.
- Refund/chargeback creates a compensating audited flow and cannot silently revert unrelated job/wallet state.
- PostgreSQL and D1 concurrency tests prove equivalent outcomes under duplicate requests and injected rollback failures.

## 8. Dependency and implementation order

1. **Resolve issue #81 first:** owner-approved canonical unit, source-unit classification, provider-facing conversion policy, rounding, limits, and historical-record treatment. Until then, no financial schema migration or provider amount can be safely finalized.
2. Finalize purpose-specific business rules and who receives each settlement; reconcile invoice-to-technician escrow and ledger semantics.
3. Review and merge provider adapter contract hardening (PR #66) only after current-main CI and sandbox behavior are independently verified; it does not itself wire routes.
4. Add attempt/outbox schema and Prisma + D1 migrations with rollback/concurrency tests.
5. Implement shared initiation, callback, verification, status and fulfillment services; keep simulator and live provider adapters behind explicit environment boundaries.
6. Add end-to-end contract tests and sandbox certification evidence for each supported provider.
7. Update readiness and operational runbooks. Keep production credentials and live activation deferred until the launch window and explicit approval.

## 9. Explicitly prohibited until approval

- No canonical-unit assumption (including treating the engineering IRR recommendation as an owner decision).
- No conversion, relabelling, bulk update or deletion of historical financial records.
- No new provider amount derived from a client request.
- No live credentials, real gateway requests, real payment, refund, payout or production activation.
- No weakening or removal of production 404/fail-closed guards to make a demo work.

**Decision:** design ready for technical review; implementation remains blocked by the monetary-unit decision and purpose-specific settlement approval.


## 10. Owner-decision update — 2026-11-07 (supersedes the monetary-unit dependency wording above)

The product owner approved **canonical integer IRR for persisted accounting amounts and Toman-only Persian presentation at the exact 10 IRR = 1 Toman ratio** on 2026-11-03 (recorded in Issue #81). Therefore, the earlier statement that the canonical unit itself is still undecided is historical and no longer current.

This resolves only the unit-policy decision. It does **not** certify existing rows as IRR and does not authorize historical conversion or live money movement.

### Current implementation consequences

- New payment attempts must snapshot a positive safe-integer amount in IRR, sourced from a server-owned business record whose `financialUnitStatus` is `VERIFIED_IRR`.
- Provider adapters must receive the exact persisted IRR amount. Do not derive a provider amount from client input or the display-only exchange-rate endpoint.
- Toman conversion is presentation-only and must occur once at the UI boundary.
- Existing technician fees, parts, invoices, wallet rows, withdrawals and legacy gateway logs remain subject to record-level provenance. Unknown rows must stay quarantined.
- The current rate card is still a proposal until Issue #99's commercial values and effective policy are approved.
- Commission, escrow hold/release, invoice-to-technician earnings, VIP pricing/refunds and withdrawal limits are not approved merely by the unit decision. No generic payment-success handler may invent these policies.
- The simulator remains non-production only. PR #139 adds a shared explicit environment allow-list; this does not wire the provider adapters into the authoritative lifecycle.

### Revised dependency status

1. Canonical persisted unit: **resolved** — integer IRR; Toman display 10:1.
2. Historical row provenance and reconciliation: **open** — Issue #81.
3. Commercial settlement and tariff decisions: **open** — Issue #99.
4. Attempt/outbox schema, provider verification, callback handling and purpose-specific fulfillment: **open** — Issue #24.
5. Sandbox certification and live activation: **deferred until the launch window and explicit approval**.

The implementation order should therefore begin with a row-provenance-safe server-owned amount resolver and purpose-specific business-policy review, not with any historical mass conversion or production credential activation.


## 11. VIP simulator hardening — 2026-11-07

The local VIP simulator now uses a server-owned plan snapshot rather than trusting a client-submitted amount:

- The initiation request supplies only the VIP plan identifier and non-financial display/contact fields. The amount, currency, payer, and purpose are resolved or assigned by the server.
- The plan must be active, marked `VERIFIED_IRR`, and have a positive safe-integer IRR price within the configured local simulator limit.
- `PaymentGatewayLog.targetPlanId` binds the attempt to the exact VIP plan. New SQLite/D1 and PostgreSQL migrations add this nullable field and index; existing historical logs remain unbound.
- Verification reloads the persisted plan and checks its current active/provenance state. The amount on the gateway attempt remains the price snapshot captured at initiation; later plan-price edits do not rewrite an in-flight attempt.
- VIP activation requires the verified gateway attempt's `targetPlanId` to equal the requested plan and exact equality between the Payment amount and its gateway-attempt amount. Cross-plan reuse and Payment/attempt amount mismatch are rejected.
- The dialog no longer sends client `userId`, amount, card CVV, or expiry to the server. The server response amount is used for the confirmation display.
- The gateway initiation/verification routes and their dialog branch are VIP-only. Prepay retains its separate local /api/prepay simulator writer; it no longer sends fake card data or creates an unrelated gateway Payment row. The prepay API still computes its own server-authoritative fees and remains blocked unless its separate policy-approval gate is enabled. Invoice and wallet-top-up are not treated as supported by either simulator path.

This is a local simulator safety improvement, not a production payment attempt/outbox implementation. Provider callbacks, provider API verification, replay protection, timeout reconciliation, refund handling and purpose-specific outbox fulfillment remain open under Issue #24. Legacy gateway logs without `targetPlanId` cannot be used to activate a new VIP subscription through this path.


## 12. VIP simulator initiation idempotency — 2026-11-07

- The VIP initiation client supplies a random request idempotency key. The key is not a payment amount or authorization token.
- The database enforces global uniqueness for the key. Repeated requests by the same authenticated user for the same active, verified VIP plan return the original gateway attempt rather than creating another one.
- Reusing a key for another user, another plan, an invalid attempt, or an attempt already marked failed/cancelled returns a conflict.
- The original amount remains the immutable attempt snapshot. A later edit to the VIP plan price does not change the amount returned for a retry of that attempt.
- If two identical initiation requests race, the unique constraint selects one persisted attempt; the losing request reloads and returns that attempt.
- The dialog preserves the same key after a transient initiation failure so a manual retry does not create a second attempt. Closing the dialog resets the key for a genuinely new checkout.
- This protects simulator initiation from duplicate requests. It does not replace provider-side idempotency, signed callback verification, durable outbox processing, reconciliation, or refund handling.


## 13. Verified payment transaction and transactional outbox — 2026-11-07

- A verified VIP simulator payment is persisted as one atomic unit: the Payment row, the PaymentGatewayLog VERIFIED link, and one PaymentOutboxEvent row.
- The outbox event is `PAYMENT_SUCCEEDED`, aggregated on the Payment ID, and carries a minimal server-authored JSON snapshot. It must never contain card PAN, CVV, expiry, OTP, or raw provider secrets.
- The stable event idempotency key is `payment.succeeded:<gatewayLogId>`. Repeated verification repairs/reuses the Payment and ensures the same outbox event exists rather than adding a second event.
- SQLite/D1 uses a single transactional D1 batch with SQL assertions; PostgreSQL/Prisma uses an interactive transaction. A failed required write must roll back all three persistence changes.
- The outbox table is durable storage, not a completed worker. No dispatcher, provider callback verification, signed webhook, retries/backoff, dead-letter operator UI, reconciliation scheduler, or refund workflow is claimed by this change.
- Outbox consumers must claim events safely, apply bounded retries, and use the event idempotency key to deduplicate side effects before any external notification or subscription fulfillment.
- The current simulator's OTP remains test-only and is not evidence of a real provider settlement.

- A legacy simulator callback that already has a verified, user-owned Payment linked by `PaymentGatewayLog.paymentId` may be repaired only if the Payment is SUCCEEDED, IRR-provenanced, amount-equal, and has no conflicting `gatewayLogId`. The repair binds that exact Payment to the gateway attempt and writes the same idempotent outbox event atomically. If the Payment is already bound elsewhere or any invariant differs, recovery fails closed.
