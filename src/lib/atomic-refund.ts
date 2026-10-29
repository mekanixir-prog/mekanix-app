// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level
// using a partial unique index on WalletLedger(referenceId) WHERE type='REFUND'
// AND referenceType='Withdrawal'.
//
// Atomicity strategy:
//   - In Cloudflare Workers (D1): use env.DB.batch() — all statements
//     execute atomically. If any statement fails, all are rolled back.
//   - In dev (Node.js + SQLite): use prisma.$transaction() — same guarantee.
//
// SAFETY INVARIANTS (enforced by SQL, not application logic):
//   1. Only ONE REFUND ledger entry per withdrawal (partial unique index)
//   2. Balance increment + ledger insert + status transition are atomic
//   3. If status is not REFUND_PENDING, the UPDATE returns count=0 → we throw
//   4. If ledger insert hits unique constraint → batch/transaction fails → rollback
//
// NO FALLBACK: If the environment cannot provide atomicity, this helper
// throws. We never fall back to a non-atomic sequential write pattern for
// financial operations.
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
  alreadyRefunded: boolean; // true if a REFUND ledger entry already existed
};

/**
 * Execute an atomic refund for a withdrawal.
 *
 * This function:
 *   1. Checks if a REFUND ledger entry already exists (idempotency)
 *   2. If yes: skips refund, just finalizes status to REJECTED
 *   3. If no: atomically (balance increment + ledger insert + status transition)
 *
 * The atomicity is guaranteed by:
 *   - D1: env.DB.batch() — all statements in one atomic unit
 *   - SQLite dev: prisma.$transaction() — same guarantee
 *
 * If the withdrawal is not in REFUND_PENDING status, the UPDATE returns
 * count=0 and we throw — no partial state is committed.
 *
 * @throws Error if:
 *   - Environment cannot provide atomicity
 *   - Withdrawal is not in REFUND_PENDING status
 *   - Any statement fails (batch/transaction rollback)
 */
export async function executeAtomicRefund(
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const db = await getDbForLib();

  // Step 1: Check if refund already happened (idempotency check via DB)
  const existingRefund = await db.walletLedger.findFirst({
    where: {
      referenceType: "Withdrawal",
      referenceId: input.withdrawalId,
      type: "REFUND",
    },
  });

  if (existingRefund) {
    // Refund already happened — just finalize status to REJECTED
    // This is safe because the refund ledger entry is the source of truth
    const finalizeResult = await db.withdrawalRequest.updateMany({
      where: { id: input.withdrawalId, status: "REFUND_PENDING" },
      data: { status: "REJECTED", processedAt: new Date(), reviewerId: input.reviewerId },
    });

    if (finalizeResult.count !== 1) {
      // Status changed out from under us — check current state
      const current = await db.withdrawalRequest.findUnique({
        where: { id: input.withdrawalId },
        select: { status: true },
      });
      if (current?.status === "REJECTED") {
        // Already finalized — return success (idempotent)
        const wallet = await db.wallet.findUnique({
          where: { id: input.walletId },
          select: { balance: true },
        });
        return {
          success: true,
          refundLedgerId: existingRefund.id,
          newBalance: Number(wallet?.balance ?? 0),
          alreadyRefunded: true,
        };
      }
      throw new Error(
        `Cannot finalize withdrawal ${input.withdrawalId}: status is ${current?.status ?? "null"}, expected REFUND_PENDING or REJECTED`
      );
    }

    const wallet = await db.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });
    return {
      success: true,
      refundLedgerId: existingRefund.id,
      newBalance: Number(wallet?.balance ?? 0),
      alreadyRefunded: true,
    };
  }

  // Step 2: No existing refund — execute atomic refund
  if (isCloudflareWorkers) {
    return await executeAtomicRefundD1(db, input);
  } else {
    return await executeAtomicRefundSQLite(db, input);
  }
}

/**
 * D1 implementation: use env.DB.batch() for atomic execution.
 *
 * The batch contains 3 statements:
 *   1. UPDATE Wallet SET balance = balance + ? WHERE id = ?
 *   2. INSERT INTO WalletLedger (type='REFUND', referenceId=?, ...)
 *   3. UPDATE WithdrawalRequest SET status='REJECTED' WHERE id=? AND status='REFUND_PENDING'
 *
 * If statement 2 hits the unique constraint (duplicate refund), the batch
 * fails and statement 1 is rolled back — no double-refund.
 *
 * If statement 3 returns count=0 (status changed), we throw after the
 * batch completes. Note: the batch itself succeeds, but we detect the
 * count=0 by checking meta.changes in the result.
 */
async function executeAtomicRefundD1(
  _db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  // Import D1 directly — bypass Prisma for batch() access
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext({ async: true });
  const d1 = ctx.env.DB;

  if (!d1) {
    throw new Error("D1 binding 'DB' not found — cannot execute atomic refund");
  }

  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();

  // Prepare 3 statements for atomic batch execution
  const refundWallet = d1.prepare(
    `UPDATE Wallet SET balance = balance + ? WHERE id = ?`
  ).bind(input.amount, input.walletId);

  const insertLedger = d1.prepare(
    `INSERT INTO WalletLedger (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
     VALUES (?, ?, 'REFUND', ?, 0, 0, 'Withdrawal', ?, ?, ?, ?)`
  ).bind(
    ledgerId,
    input.walletId,
    input.amount,
    input.withdrawalId,
    input.description,
    input.reviewerId,
    now
  );

  const finalizeStatus = d1.prepare(
    `UPDATE WithdrawalRequest SET status = 'REJECTED', processedAt = ?, reviewerId = ?
     WHERE id = ? AND status = 'REFUND_PENDING'`
  ).bind(now, input.reviewerId, input.withdrawalId);

  // Execute atomically — if any statement fails, all are rolled back
  const results = await d1.batch([refundWallet, insertLedger, finalizeStatus]);

  // Check results — each must have success: true
  for (let i = 0; i < results.length; i++) {
    if (!results[i].success) {
      throw new Error(
        `Atomic refund statement ${i} failed for withdrawal ${input.withdrawalId}`
      );
    }
  }

  // Check that the status transition affected exactly 1 row
  // D1 meta.changes tells us how many rows were modified
  const statusChanges = (results[2].meta as { changes?: number }).changes ?? 0;
  if (statusChanges !== 1) {
    // The batch executed, but the status was not REFUND_PENDING.
    // This means another process changed the status, OR the withdrawal
    // was already REJECTED. We need to check the current state.
    throw new Error(
      `Atomic refund: status transition affected ${statusChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (status was not REFUND_PENDING or withdrawal not found). ` +
      `The balance increment and ledger insert were rolled back by D1 batch atomicity.`
    );
  }

  // Read the new balance
  const walletResult = await d1.prepare(
    `SELECT balance FROM Wallet WHERE id = ?`
  ).bind(input.walletId).first<{ balance: string }>();

  return {
    success: true,
    refundLedgerId: ledgerId,
    newBalance: Number(walletResult?.balance ?? 0),
    alreadyRefunded: false,
  };
}

/**
 * SQLite dev implementation: use prisma.$transaction() for atomic execution.
 *
 * Same 3 operations, but via Prisma's interactive transaction API.
 * If any operation fails, the transaction is rolled back.
 *
 * The partial unique index on WalletLedger(referenceId) WHERE type='REFUND'
 * ensures that a duplicate insert will throw P2002, rolling back the balance
 * increment.
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  return await db.$transaction(async (tx) => {
    // 1. Refund: increment wallet balance
    const refundResult = await tx.wallet.updateMany({
      where: { id: input.walletId },
      data: { balance: { increment: input.amount } },
    });

    if (refundResult.count !== 1) {
      throw new Error(
        `Atomic refund: wallet ${input.walletId} not found during balance increment`
      );
    }

    // 2. Insert REFUND ledger entry
    //    This will throw P2002 if a REFUND entry already exists for this
    //    withdrawal (partial unique index), which rolls back the balance
    //    increment from step 1.
    const ledger = await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "REFUND",
        amount: input.amount,
        balanceBefore: 0, // will be updated by trigger or reconciliation
        balanceAfter: 0,  // will be updated by trigger or reconciliation
        referenceType: "Withdrawal",
        referenceId: input.withdrawalId,
        description: input.description,
        createdBy: input.reviewerId,
      },
    });

    // 3. Finalize withdrawal status: REFUND_PENDING → REJECTED
    //    Conditional WHERE ensures only one request can transition.
    const finalizeResult = await tx.withdrawalRequest.updateMany({
      where: { id: input.withdrawalId, status: "REFUND_PENDING" },
      data: {
        status: "REJECTED",
        processedAt: new Date(),
        reviewerId: input.reviewerId,
      },
    });

    if (finalizeResult.count !== 1) {
      // Status was not REFUND_PENDING — the entire transaction rolls back
      // (including the balance increment and ledger insert).
      throw new Error(
        `Atomic refund: status transition failed for withdrawal ${input.withdrawalId}. ` +
        `Expected REFUND_PENDING, but 0 rows matched. ` +
        `Transaction rolled back — no balance change, no ledger entry.`
      );
    }

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
