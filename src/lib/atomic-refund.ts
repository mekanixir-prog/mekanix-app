// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level
// using a partial unique index on WalletLedger(referenceId) WHERE type='REFUND'
// AND referenceType='Withdrawal'.
//
// DESIGN: ALL operations (status guard, balance increment, ledger insert)
// happen inside a SINGLE atomic unit. Nothing is checked before or after
// the atomic unit. This eliminates race windows.
//
// Atomicity strategy:
//   - In Cloudflare Workers (D1): use env.DB.batch() — all statements
//     execute atomically. If any statement fails, all are rolled back.
//   - In dev (Node.js + SQLite): use prisma.$transaction() — same guarantee.
//
// STATEMENT ORDER (critical for safety):
//   1. UPDATE WithdrawalRequest SET status='REJECTED'
//      WHERE id=? AND status='REFUND_PENDING'
//      → If count=0, status was wrong. We check this FIRST inside the
//        transaction. If it fails, we ABORT before any balance change.
//   2. UPDATE Wallet SET balance = balance + ? WHERE id = ?
//      → Only runs if statement 1 succeeded (inside same transaction)
//   3. INSERT INTO WalletLedger (type='REFUND', referenceId=?, ...)
//      → If unique constraint violated (double-refund), transaction aborts
//        and statements 1+2 are rolled back.
//
// SAFETY INVARIANTS (enforced by DB + transaction):
//   1. Only ONE REFUND ledger entry per withdrawal (partial unique index)
//   2. Balance increment + ledger insert + status transition are atomic
//   3. If status is not REFUND_PENDING, NOTHING happens (no balance change)
//   4. If ledger insert hits unique constraint → rollback (no double-refund)
//
// IDEMPOTENCY: handled INSIDE the transaction.
//   - Statement 1 (status guard) is the gate: if status is already
//     REJECTED, count=0 → we check and return "alreadyRefunded" WITHOUT
//     modifying balance or ledger.
//   - If status is REFUND_PENDING, we proceed with balance + ledger.
//   - If a REFUND ledger already exists (edge case: status was reset to
//     REFUND_PENDING after a partial failure), the unique index blocks
//     the insert → transaction rolls back → we detect and handle.
//
// NO FALLBACK: If the environment cannot provide atomicity, this helper
// throws. We never fall back to non-atomic sequential writes.
//
// NOT in scope: withIdempotency in auth.ts (separate follow-up)

import { getDbForLib } from "@/lib/db-access";
import type { PrismaClient } from "@prisma/client";

const isCloudflareWorkers =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

export type AtomicRefundInput = {
  withdrawalId: string;
  walletId: string;
  amount: number;
  reviewerId: string;
  description: string;
};

export type AtomicRefundResult = {
  success: boolean;
  refundLedgerId: string | null;
  newBalance: number;
  alreadyRefunded: boolean; // true if withdrawal was already REJECTED
};

/**
 * Execute an atomic refund for a withdrawal.
 *
 * ALL operations happen inside a single atomic unit:
 *   1. Status guard: transition REFUND_PENDING → REJECTED (conditional)
 *   2. Balance increment
 *   3. Ledger insert (with partial unique index)
 *
 * If any step fails, the entire operation rolls back.
 *
 * @throws Error if:
 *   - Environment cannot provide atomicity
 *   - Withdrawal is not in REFUND_PENDING status (and not already REJECTED)
 *   - Any statement fails (batch/transaction rollback)
 */
export async function executeAtomicRefund(
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const db = await getDbForLib();

  if (isCloudflareWorkers) {
    return await executeAtomicRefundD1(db, input);
  } else {
    return await executeAtomicRefundSQLite(db, input);
  }
}

/**
 * D1 implementation: use env.DB.batch() for atomic execution.
 *
 * The batch contains 3 statements (in this exact order):
 *   1. UPDATE WithdrawalRequest SET status='REJECTED'
 *      WHERE id=? AND status='REFUND_PENDING'
 *      → count must be 1, else abort
 *   2. UPDATE Wallet SET balance = balance + ? WHERE id = ?
 *   3. INSERT INTO WalletLedger (type='REFUND', referenceId=?, ...)
 *      → unique index violation aborts the batch
 *
 * IDEMPOTENCY: Before the batch, we check the current status.
 *   - If REJECTED: return alreadyRefunded=true (no batch needed)
 *   - If REFUND_PENDING: proceed with batch
 *   - Otherwise: throw
 *
 * Note: The pre-check is NOT the atomic guard — the atomic guard is
 * statement 1's WHERE clause inside the batch. The pre-check is just
 * an optimization to avoid throwing for already-completed refunds.
 */
async function executeAtomicRefundD1(
  _db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext({ async: true });
  const d1 = ctx.env.DB;

  if (!d1) {
    throw new Error("D1 binding 'DB' not found — cannot execute atomic refund");
  }

  // Pre-check: is the withdrawal already REJECTED? (idempotency optimization)
  // This is NOT the atomic guard — it just avoids throwing for completed refunds.
  const current = await d1.prepare(
    `SELECT status FROM WithdrawalRequest WHERE id = ?`
  ).bind(input.withdrawalId).first<{ status: string }>();

  if (!current) {
    throw new Error(`Withdrawal ${input.withdrawalId} not found`);
  }

  if (current.status === "REJECTED") {
    // Already finalized — check if refund ledger exists
    const existingLedger = await d1.prepare(
      `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
       AND referenceId = ? AND type = 'REFUND' LIMIT 1`
    ).bind(input.withdrawalId).first<{ id: string }>();

    const wallet = await d1.prepare(
      `SELECT balance FROM Wallet WHERE id = ?`
    ).bind(input.walletId).first<{ balance: string }>();

    if (!existingLedger) {
      throw new Error(
        `Withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger; manual reconciliation required`
      );
    }
    return {
      success: true,
      refundLedgerId: existingLedger.id,
      newBalance: Number(wallet?.balance ?? 0),
      alreadyRefunded: true,
    };
  }

  if (current.status !== "REFUND_PENDING") {
    throw new Error(
      `Withdrawal ${input.withdrawalId} status is ${current.status}, expected REFUND_PENDING or REJECTED`
    );
  }

  // IMPORTANT: D1 batch() is atomic for statement errors, but a conditional
  // UPDATE affecting 0 rows does NOT itself abort the batch. Therefore every
  // write below independently requires the withdrawal to still be
  // REFUND_PENDING and linked to this wallet. The final status update is last.
  // If the state guard is false, all statements are no-ops; no money moves.
  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();

  const stmt1_balance = d1.prepare(
    `UPDATE Wallet
     SET balance = balance + ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1 FROM WithdrawalRequest
         WHERE id = ? AND walletId = ? AND status = 'REFUND_PENDING'
       )`
  ).bind(input.amount, input.walletId, input.withdrawalId, input.walletId);

  const stmt2_ledger = d1.prepare(
    `INSERT INTO WalletLedger
       (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
     SELECT ?, ?, 'REFUND', ?, 0, 0, 'Withdrawal', ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM WithdrawalRequest
       WHERE id = ? AND walletId = ? AND status = 'REFUND_PENDING'
     )
       AND EXISTS (SELECT 1 FROM Wallet WHERE id = ?)`
  ).bind(
    ledgerId,
    input.walletId,
    input.amount,
    input.withdrawalId,
    input.description,
    input.reviewerId,
    now,
    input.withdrawalId,
    input.walletId,
    input.walletId
  );

  const stmt3_status = d1.prepare(
    `UPDATE WithdrawalRequest
     SET status = 'REJECTED', processedAt = ?, reviewerId = ?
     WHERE id = ? AND walletId = ? AND status = 'REFUND_PENDING'
       AND EXISTS (SELECT 1 FROM Wallet WHERE id = ?)`
  ).bind(now, input.reviewerId, input.withdrawalId, input.walletId, input.walletId);

  let results;
  try {
    results = await d1.batch([stmt1_balance, stmt2_ledger, stmt3_status]);
  } catch (batchError: unknown) {
    // Any SQL error (including the partial unique index) rolls back the batch.
    // Never infer that a unique error means success without checking ledger.
    const errMsg = String((batchError as Error)?.message ?? "");
    if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
      const [recheck, existingLedger, wallet] = await Promise.all([
        d1.prepare(`SELECT status FROM WithdrawalRequest WHERE id = ?`)
          .bind(input.withdrawalId).first<{ status: string }>(),
        d1.prepare(`SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND' LIMIT 1`)
          .bind(input.withdrawalId).first<{ id: string }>(),
        d1.prepare(`SELECT balance FROM Wallet WHERE id = ?`)
          .bind(input.walletId).first<{ balance: string }>(),
      ]);
      if (recheck?.status === "REJECTED" && existingLedger) {
        return {
          success: true,
          refundLedgerId: existingLedger.id,
          newBalance: Number(wallet?.balance ?? 0),
          alreadyRefunded: true,
        };
      }
    }
    throw batchError;
  }

  if (results.some((result) => !result.success)) {
    throw new Error(`Atomic refund batch failed for withdrawal ${input.withdrawalId}`);
  }

  const changes = results.map((result) => (result.meta as { changes?: number }).changes ?? 0);
  // All three writes must affect exactly one row. Because each statement is
  // independently gated by the same pending withdrawal + wallet relationship,
  // an invalid/stale state produces three no-ops and never changes balance.
  // A mixed result is treated as an invariant violation and must be reconciled.
  if (changes.some((count) => count !== 1)) {
    const [recheck, existingLedger, wallet] = await Promise.all([
      d1.prepare(`SELECT status FROM WithdrawalRequest WHERE id = ?`)
        .bind(input.withdrawalId).first<{ status: string }>(),
      d1.prepare(`SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND' LIMIT 1`)
        .bind(input.withdrawalId).first<{ id: string }>(),
      d1.prepare(`SELECT balance FROM Wallet WHERE id = ?`)
        .bind(input.walletId).first<{ balance: string }>(),
    ]);

    if (changes.every((count) => count === 0) && recheck?.status === "REJECTED" && existingLedger) {
      return {
        success: true,
        refundLedgerId: existingLedger.id,
        newBalance: Number(wallet?.balance ?? 0),
        alreadyRefunded: true,
      };
    }

    if (changes.every((count) => count === 0)) {
      throw new Error(
        `Atomic refund not applied: withdrawal ${input.withdrawalId} is not REFUND_PENDING or wallet relationship is invalid`
      );
    }

    console.error("[atomic-refund] CRITICAL: inconsistent atomic batch result", {
      withdrawalId: input.withdrawalId,
      walletId: input.walletId,
      changes,
      note: "Do not retry automatically; manually reconcile wallet balance and refund ledger.",
    });
    throw new Error(`Atomic refund invariant violation for withdrawal ${input.withdrawalId}; manual reconciliation required`);
  }

  const wallet = await d1.prepare(
    `SELECT balance FROM Wallet WHERE id = ?`
  ).bind(input.walletId).first<{ balance: string }>();

  return {
    success: true,
    refundLedgerId: ledgerId,
    newBalance: Number(wallet?.balance ?? 0),
    alreadyRefunded: false,
  };
}

/**
 * SQLite dev implementation: use prisma.$transaction() for atomic execution.
 *
 * Same 3 operations, but via Prisma's interactive transaction API.
 * Order: status guard FIRST, then balance, then ledger.
 *
 * If any operation fails, the transaction is rolled back.
 *
 * The partial unique index on WalletLedger(referenceId) WHERE type='REFUND'
 * ensures that a duplicate insert will throw P2002, rolling back the balance
 * increment AND the status transition.
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  return await db.$transaction(async (tx) => {
    // 1. Status guard: transition REFUND_PENDING → REJECTED
    //    This is the gate: if status is wrong, NOTHING else happens.
    const statusResult = await tx.withdrawalRequest.updateMany({
      where: { id: input.withdrawalId, status: "REFUND_PENDING" },
      data: {
        status: "REJECTED",
        processedAt: new Date(),
        reviewerId: input.reviewerId,
      },
    });

    if (statusResult.count !== 1) {
      // Status was not REFUND_PENDING. Check if already REJECTED (idempotent).
      const current = await tx.withdrawalRequest.findUnique({
        where: { id: input.withdrawalId },
        select: { status: true },
      });

      if (current?.status === "REJECTED") {
        // Already refunded — return idempotent result.
        // The transaction will commit (no changes made).
        const existingLedger = await tx.walletLedger.findFirst({
          where: {
            referenceType: "Withdrawal",
            referenceId: input.withdrawalId,
            type: "REFUND",
          },
        });
        const wallet = await tx.wallet.findUnique({
          where: { id: input.walletId },
          select: { balance: true },
        });
        if (!existingLedger) {
          throw new Error(
            `Withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger; manual reconciliation required`
          );
        }
        return {
          success: true,
          refundLedgerId: existingLedger.id,
          newBalance: Number(wallet?.balance ?? 0),
          alreadyRefunded: true,
        };
      }

      // Not REFUND_PENDING and not REJECTED — abort.
      throw new Error(
        `Atomic refund: withdrawal ${input.withdrawalId} status is ${current?.status ?? "null"}, expected REFUND_PENDING or REJECTED. Transaction rolled back — no balance change.`
      );
    }

    // 2. Refund: increment wallet balance
    //    Only reached if status guard succeeded (count=1).
    const refundResult = await tx.wallet.updateMany({
      where: { id: input.walletId },
      data: { balance: { increment: input.amount } },
    });

    if (refundResult.count !== 1) {
      throw new Error(
        `Atomic refund: wallet ${input.walletId} not found during balance increment. Transaction rolled back.`
      );
    }

    // 3. Insert REFUND ledger entry
    //    This will throw P2002 if a REFUND entry already exists for this
    //    withdrawal (partial unique index), which rolls back BOTH the balance
    //    increment AND the status transition from steps 1+2.
    const ledger = await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "REFUND",
        amount: input.amount,
        balanceBefore: 0,
        balanceAfter: 0,
        referenceType: "Withdrawal",
        referenceId: input.withdrawalId,
        description: input.description,
        createdBy: input.reviewerId,
      },
    });

    // Read new balance for the response
    const wallet = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });

    return {
      success: true,
      refundLedgerId: ledger.id,
      newBalance: Number(wallet?.balance ?? 0),
      alreadyRefunded: false,
    };
  });
}
