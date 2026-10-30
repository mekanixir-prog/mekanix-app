# Financial Ledger Atomicity Review

**Status:** Investigation / implementation gate  
**Date:** 2026-10-30  
**Scope:** Wallet escrow release, prepay settlement, withdrawals, and the D1/Prisma runtime split.

This document records verified source-level findings and the database constraint that must shape the fix. It does not claim that any financial mutation has been repaired.

## Executive finding

The current financial flows contain multi-step writes where a process interruption can leave business state and wallet balances inconsistent. A Prisma interactive transaction cannot be used as a portable fix because the production runtime uses Cloudflare D1 through `@prisma/adapter-d1`, and Prisma ORM v6 documents that D1 does not support transactions; implicit and explicit Prisma transactions are ignored by that adapter.

For D1, the supported atomic primitive is `env.DB.batch([...])`: Cloudflare documents that the statements execute sequentially and non-concurrently as a SQL transaction, and a failure aborts/rolls back the whole batch. Node/SQLite and PostgreSQL can use Prisma transactions, but the D1 path must use the D1 binding's batch API (or a database-side procedure where applicable).

## Verified findings in current `main`

### 1. Wallet escrow release: split state transition and balance transfer

File: `src/app/api/wallets/route.ts`

The GET handler currently:
1. Reads wallet transactions.
2. Changes a releasable `WalletTransaction` from `PENDING` to `AVAILABLE` using conditional `updateMany`.
3. In a separate database call, decrements `pendingBalance` and increments `balance`.

The conditional update prevents two readers from both winning the state transition, but it does not make the transaction-status change and wallet-balance transfer atomic. If the second write fails after the first succeeds, the transaction is AVAILABLE while the wallet aggregate was not transferred. The route also performs financial mutation during a GET request.

**Required invariant:** one release operation must either change the transaction state and transfer both wallet balances together, or change neither. The read endpoint should not be responsible for initiating this mutation; release should be an explicit service/worker operation with retryable semantics.

### 2. Prepay: paid flag precedes ledger and wallet writes

File: `src/app/api/prepay/route.ts`

The handler conditionally sets `Job.prepayPaid = true` first. It then separately creates the wallet if needed, creates PREPAY and COMMISSION wallet transactions, updates wallet aggregates, and writes notifications/messages.

A failure after the job update can leave `prepayPaid=true` without the corresponding transaction rows and wallet aggregates. The early `alreadyPaid` response makes a retry return before repairing those missing financial records.

**Required invariant:** job payment state, the two financial transaction rows, and wallet aggregate/ledger changes must be committed as one logical idempotent operation. Notifications and chat messages may be emitted after the financial commit through a retryable outbox or deduplicated post-commit step.

### 3. Withdrawal: debit can succeed before a durable withdrawal request exists

File: `src/app/api/wallets/withdraw/route.ts`

The handler conditionally decrements wallet balance first, then separately creates the withdrawal request and ledger entry. This prevents an orphan withdrawal request from being paid without a debit, but a failure between the debit and request creation can leave money deducted without a durable withdrawal record to reconcile.

**Required invariant:** debit, withdrawal request, and ledger entry must be atomic, or the debit must be represented by a durable idempotent reservation record created atomically before any later processing.

### 4. Runtime/database split

Files: `src/lib/db-access.ts`, `src/lib/db-worker.ts`, `wrangler.toml`, `package.json`

- Worker runtime constructs PrismaClient with `new PrismaD1(env.DB)`.
- Node runtime uses the standard Prisma client.
- The production Worker has a D1 binding named `DB`.
- The project pins `@prisma/adapter-d1` to 6.19.3.

Do not add `$transaction(async tx => ...)` to shared code and assume it protects D1 writes. The D1 adapter does not provide interactive transactions.

## Implementation design gate

### D1 / Cloudflare Worker

Use the actual `D1Database` binding from `getCloudflareContext({ async: true })` and `env.DB.batch(preparedStatements)` for each multi-row financial mutation. Bind all values with `prepare(sql).bind(...)`; never interpolate user-controlled values into SQL.

For escrow release, use a single atomic batch whose statements share the same eligibility predicate:
- wallet row exists;
- target wallet transaction belongs to that wallet;
- status is PENDING;
- holdUntil is due.
The wallet aggregate transfer and transaction status transition must both be guarded by that predicate. A failed statement must roll back the batch. Confirm the result metadata and final rows in D1 integration tests.

For prepay and withdrawal, introduce durable idempotency keys / unique ledger references so a retry can distinguish “already committed” from “not yet applied”. Keep the job flag, wallet transaction rows, aggregate changes, and ledger entries in the same D1 batch. Do not rely on a sequence of independent Prisma calls.

### Node / SQLite and PostgreSQL

Use a database transaction for the corresponding multi-row operation. Conditional updates must still be checked inside the transaction; merely placing unconditional writes in a transaction does not prevent replay or duplicate settlement. Keep network calls and notification delivery outside the transaction.

### Required tests before considering the fix complete

- Release: one eligible transaction; not-yet-due transaction; two concurrent release attempts; injected failure after the first statement; retry after a failed attempt; assert transaction status and both wallet balances remain consistent.
- Prepay: first payment; duplicate request; concurrent requests; injected failure at each financial write boundary; retry after each failure; assert exactly one PREPAY row, one commission row, and one aggregate/ledger application.
- Withdrawal: concurrent withdrawals near the available balance; injected failure during request/ledger creation; retry and reconciliation; assert no money disappears and no payout can exist without a corresponding debit.
- Run the same behavior tests against local SQLite/PostgreSQL and a D1-compatible integration environment. Mocks alone are insufficient to prove D1 batch atomicity or database uniqueness behavior.

## Related gateway verification work

PR #10 adds a unique `Payment.gatewayLogId` key and a retry-repair path for the simulator's gateway log. Its exact head SHA `74b6bc724f381d94b29a9e05a57c2abf88c87b8f` currently has 5/5 GitHub Actions runs successful (CI, Cloudflare Build, Production readiness, PostgreSQL CI, Docker E2E). The PR remains Draft and unmerged. These CI results do not replace a real D1 migration/runtime test.

## External technical references

- Prisma ORM v6 D1 limitations: https://www.prisma.io/docs/orm/v6/overview/databases/cloudflare-d1
- Prisma ORM v6 transactions API: https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions
- Cloudflare D1 batch API and rollback semantics: https://developers.cloudflare.com/d1/worker-api/d1-database/

## Release decision

Do not merge financial-flow changes or enable real payment providers until the D1 and PostgreSQL integration tests prove the invariants above. Hosting/domain/SMS/payment activation remains a separate, intentionally deferred release task; this review does not treat those deferred activations as current development blockers.
