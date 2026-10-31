# MEKANIX — Idempotency Call-Site Inventory

**Audit date:** 2026-10-31  
**Repository:** `mekanixir-prog/mekanix-app`  
**Initial audit main commit:** `a641cddb880df262980f2d7cff4ce77fb6903c05`\n**Follow-up mainline updates:** PR #36, #35, #33 and #38 have since merged.  
**Scope:** all 69 files under `src/app/api/`, all 50 modules under `src/lib/`, the auth barrel under `src/modules/`, and offline queue/sync code plus the E2E tests that previously exercised the generic helper.  
**Decision:** the generic `withIdempotency()` helper had no production call sites and was removed. Issue #29 remains open until a reviewed durable state machine is required by a real caller and passes crash/concurrency tests.

## 1. Generic helper inventory

The old `src/lib/auth.ts` helper performed read → callback → upsert and had no in-progress claim, request fingerprint, or atomic ownership. Its broad catch also allowed a callback to run again after an uncertain failure. It was not safe for concurrent financial operations.

The repository-wide source inventory found:

- No production imports or invocations of `withIdempotency()` in the API route tree or shared library modules.
- The auth barrel only re-exported the helper; those exports were removed.
- The only remaining references were helper-only E2E tests. Those tests were removed because they tested a utility that no production endpoint called, not a real route-level guarantee.
- No callers of `getIdempotencyKey()` outside the helper.
- The helper was therefore not protecting any production endpoint. It has been removed rather than retained as a misleading security primitive.
- The `IdempotencyKey` schema/table and historical migrations are intentionally retained for now; removing a persisted table requires a separate compatibility and data-retention review.

The offline sync client did send an `Idempotency-Key` header for every queued action. A header alone does not create server-side idempotency. The client behavior has been corrected below.

## 2. Route-specific protections found

| Operation | Existing protection | Boundary / remaining work |
|---|---|---|
| `POST /api/wallets/withdraw` | Unique `WithdrawalRequest.idempotencyKey`; payload comparison on replay; D1/Prisma atomic debit and ledger write; concurrent unique-key race recovery | Live money movement still requires provider/operational controls before production use |
| `POST /api/prepay` | Per-job `prepayPaid` transition plus unique WalletTransaction/WalletLedger keys; retry verifies all required financial rows before returning already-paid | Simulator-only; production endpoint returns 404; this is not a real gateway |
| `PATCH /api/admin/withdrawals/:id` | Merged in PR #36; conditional state transitions; atomic wallet/ledger or payout transaction writes; deterministic payout idempotency key; real external bank transfer reference required | Records proof of a manually executed bank transfer; does not initiate the transfer |
| `POST /api/gateway/verify` | Merged PR #33 adds unique Payment.gatewayLogId, duplicate callback convergence, and recovery if the Payment exists but the GatewayLog link failed | Simulator-only and production returns 404; not a real provider callback or live settlement |
| `POST /api/payments` | Invoice PAID checks and optimistic state updates | Simulator-only; no general idempotency-key contract; production returns 404; never treat as real payment settlement |
| Escrow release | Existing ledger idempotency keys and atomic release work; dedicated Cron Worker tracked separately | PR #30 still requires isolated Cloudflare D1/Cron staging validation before deployment |

## 3. Offline queue retry policy

The previous sync engine retried every POST/PATCH/DELETE after a network error or 5xx. That is unsafe: the server may have committed the mutation before the response was lost.

The updated client now:

1. Automatically retries only the verified route-specific contracts:
   - `POST /api/wallets/withdraw`
   - `POST /api/prepay`
2. Treats an explicit 429 as a rejected attempt and applies the bounded retry counter.
3. For other endpoints, retains an action after an ambiguous network/5xx outcome and marks it `needsReconciliation`; it is not silently replayed.
4. Exposes `reconciliationRequired` in the sync result.
5. Provides `retryAfterReconciliation(id)`, which only clears the gate after a caller/operator has checked the server-side state.

This avoids claiming exactly-once behavior where the endpoint does not provide it. A dedicated user-facing reconciliation screen is still needed before offline mutation sync is considered fully production-ready.

## 4. Deferred architecture for a future generic helper

Do not reintroduce a generic callback wrapper until there is a real route caller and a reviewed state machine with:

- key scope = authenticated principal + operation + canonical request fingerprint;
- atomic durable claim and owner token;
- explicit IN_PROGRESS / COMPLETED / FAILED or reconciliation states;
- same key + different payload → 409;
- concurrent duplicate → replay completed response or deterministic in-progress response;
- no callback execution from storage-error handlers;
- business mutation and completion record in one transaction where possible;
- D1 recovery/reconciliation semantics where one transaction cannot span the workflow;
- production store outage → 503;
- 50–100 concurrent and crash-window tests on SQLite/D1-compatible SQL and PostgreSQL.

A cache-only table is not an exactly-once guarantee.

## 5. Release decision

Issue #29 remains **OPEN**. This inventory and removal of the unsafe unused helper are partial remediation, not completion of the generic idempotency architecture. Before release, every state-changing route reachable from offline sync must either have a route-specific durable idempotency contract or remain behind manual reconciliation.
