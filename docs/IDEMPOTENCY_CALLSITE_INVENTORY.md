# MEKANIX — Idempotency Call-Site Inventory

**Audit date:** 2026-11-01  
**Repository:** `mekanixir-prog/mekanix-app`  
**Scope:** API routes, shared libraries, offline queue/sync, reconciliation UI, SQLite/D1-compatible integration tests, and PostgreSQL integration tests.

## Decision

The generic `withIdempotency()` callback helper was unsafe and had no production call sites. It was removed in PR #39 and will not be reintroduced as a generic wrapper. MEKANIX now uses operation-specific contracts: each critical route defines its own key scope, canonical SHA-256 SHA-256 request fingerprint, atomic business writes, replay behavior, conflict behavior, and read-only reconciliation endpoint.

The canonical request payload is normalized and SHA-256 hashed before persistence; raw addresses, descriptions, media URLs, and other submitted fields are not duplicated in fingerprint columns. The historical `IdempotencyKey` table and migrations remain for compatibility; they are not treated as proof that any route is protected.

## 1. Route-specific production contracts

| Operation | Durable contract | Server-side reconciliation | Operational boundary |
|---|---|---|---|
| `POST /api/wallets/withdraw` | Unique `WithdrawalRequest.idempotencyKey`; fingerprint comparison; atomic wallet debit + immutable ledger writes; concurrent unique-key recovery | `GET /api/wallets/withdraw/status` proves withdrawal and ledger rows agree before COMMITTED | Real money movement still requires separately approved payout/provider operations |
| `POST /api/prepay` | Per-job paid transition plus unique wallet transaction/ledger keys; replay verifies all required financial rows | Job/payment proof read before reporting already-paid | Simulator-only; production endpoint returns 404 |
| `PATCH /api/admin/withdrawals/:id` | Conditional state transition; atomic wallet/ledger or payout-proof writes; deterministic payout idempotency key | Withdrawal/ledger state is queryable from admin records | Records proof of a manually executed bank transfer; does not initiate the transfer |
| `POST /api/gateway/verify` | Unique `Payment.gatewayLogId`; duplicate callback convergence and recovery for a missing gateway-log link | Gateway log and payment record are checked together | Simulator-only; production endpoint returns 404 |
| `POST /api/payments` | No live settlement contract by design | Not applicable | Simulator-only; production endpoint returns 404; never treat as real payment |
| `POST /api/care/bookings` | PR #59: unique booking key + request fingerprint; booking, frozen pricing snapshot, link, and creation event in one Prisma transaction or D1 batch | `GET /api/care/bookings/status?key=...` requires booking, snapshot, link, and event to agree | D1/SQLite and PostgreSQL failure/concurrency integration coverage in PR #61 |
| `POST /api/service-requests` | PR #60: unique request key + fingerprint; optional ad-hoc vehicle and request in one Prisma transaction or D1 batch; notifications post-commit | `GET /api/service-requests/status?key=...` verifies the request's vehicle relation and ownership | Same key + different payload returns 409 |
| `POST /api/insurance/claim` | PR #60: unique claim key + fingerprint; claim and policy transition in one Prisma transaction or D1 batch; expired/cancelled policy guard; notifications post-commit | `GET /api/insurance/claim/status?key=...` verifies claim and policy status | Same key + different payload returns 409 |

### Client key persistence

CARE booking, service request, and insurance claim forms persist the pending key and request fingerprint in session storage. Identical retries—including after a page reload—reuse the same key. A changed payload gets a new key. The key is cleared only after a successful response.

## 2. Offline queue and reconciliation policy

The offline sync engine only retries a POST after an ambiguous network/5xx result when both conditions hold:

1. The action has a durable `Idempotency-Key`.
2. The route is in the explicit server-contract allowlist:
   - `/api/wallets/withdraw`
   - `/api/prepay`
   - `/api/gateway/verify` (simulator-only)
   - `/api/care/bookings`
   - `/api/service-requests`
   - `/api/insurance/claim`

The Persian offline reconciliation center (PR #50) checks the matching read-only status endpoint. It only offers a safe retry after an explicit `NOT_COMMITTED` response. `COMMITTED` clears the pending action; `KEY_CONFLICT` and `RECONCILIATION_REQUIRED` remain behind manual review. Unsupported endpoints are never automatically replayed.

Other safety rules remain:
- 429 responses use bounded retry handling.
- Persisted queue entries cannot send credentials to cross-origin URLs.
- Ambiguous non-idempotent POST/PATCH/DELETE actions are retained for manual reconciliation rather than silently replayed.
- A request header alone is not considered a server-side idempotency guarantee.

## 3. Concurrency and failure-injection evidence

- Wallet withdrawal and escrow release have D1/SQLite-compatible and PostgreSQL transaction coverage for duplicate release, insufficient balance, and rollback.
- CARE booking: PR #61 adds 100 concurrent D1/SQLite retries and 80 concurrent PostgreSQL retries, plus injected failures after pricing insert, snapshot-link update, and timeline insert.
- Service request and insurance claim: PR #60 adds 100 concurrent D1/SQLite retries and 80 concurrent PostgreSQL retries, plus rollback tests after vehicle insert and claim insert/policy transition.
- Rate-limit window initialization is atomic for SQLite/D1-compatible SQL and PostgreSQL (PR #40); production store failure remains fail-closed with HTTP 503 (PR #27).

## 4. Explicitly deferred

A generic callback-based exactly-once wrapper remains deferred because there is no production caller that needs a common generic abstraction. Reintroducing one would obscure materially different transaction boundaries and recovery semantics. Any future generic helper requires a real caller, a separate reviewed state machine, and route-level concurrency/crash tests before use.

Payment-provider settlement is not an idempotent live route yet: payment endpoints remain simulator-only and return 404 in production. Provider selection, sandbox credentials, callback URL/domain, and explicit activation approval are separate release prerequisites.

The scheduled wallet escrow Cron Worker is PR #43. Its cross-run cursor and failure-isolated pagination are covered by tests, but it remains a draft until an isolated Cloudflare D1/Cron staging run is observed. No production D1 migration or Worker deployment has occurred.

## 5. Resolution

The unsafe unused generic helper is removed; all currently enabled critical create/financial routes have operation-specific contracts or remain disabled in production. The offline reconciliation UI is present and only retries verified routes. Issue #29 is therefore **deferred/not planned as a generic helper**, not an unresolved production caller. Route-specific implementation and test evidence is tracked in PRs #59–#61.
