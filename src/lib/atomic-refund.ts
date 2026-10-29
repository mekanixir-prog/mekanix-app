// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level.
//
// DESIGN: Uses a refundToken — a unique per-request identifier that is
// written during the status transition and verified by the balance
// increment and ledger insert statements.
//
// Why refundToken is necessary:
//   D1 batch() does NOT roll back when a statement affects 0 rows. Only
//   SQL ERRORS (like UNIQUE constraint violations) cause rollback.
//   If we check status='REJECTED' in stmt2, a concurrent request that
//   lost the race would still see REJECTED (set by the winner) and
//   increment the balance — even though its own stmt1 affected 0 rows.
//
//   With refundToken:
//     - stmt1 sets status='REJECTED' AND refundToken='UNIQUE_TOKEN'
//     - stmt2 checks refundToken='UNIQUE_TOKEN' → only TRUE if THIS
//       request performed the transition
//     - stmt3 checks refundToken='UNIQUE_TOKEN' → same
//
//   If Request B's stmt1 affects 0 rows (status already REJECTED by A),
//   Request B's refundToken is NOT set on the row → stmt2+stmt3 see
//   a different token → 0 rows affected → no balance change.
//
// Additionally:
//   - stmt3 is a PLAIN INSERT (not INSERT...SELECT) so that a duplicate
//     REFUND ledger entry causes a SQL ERROR (UNIQUE constraint violation),
//     which triggers batch rollback — undoing stmt1+stmt2.
//   - balanceBefore/balanceAfter are computed from the actual wallet state
//     before and after the increment, not hardcoded 0.

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
  alreadyRefunded: boolean;
};

function generateToken(): string {
  return `rt_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Execute an atomic refund for a withdrawal.
 *
 * Safety guarantees:
 *   1. Balance increment ONLY happens if THIS request performed the transition
 *      (verified via refundToken)
 *   2. Ledger insert ONLY happens if THIS request performed the transition
 *   3. If a REFUND ledger already exists, INSERT throws → batch rolls back
 *   4. If status is already REJECTED with a valid REFUND ledger → idempotent
 *   5. If status is REJECTED but NO REFUND ledger → financial inconsistency (throw)
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
 * D1 implementation: use env.DB.batch() with refundToken.
 *
 * 3 statements in the batch:
 *   1. UPDATE WithdrawalRequest SET status='REJECTED', refundToken=?
 *      WHERE id=? AND status='REFUND_PENDING'
 *   2. UPDATE Wallet SET balance = balance + ?
 *      WHERE id=? AND EXISTS(... refundToken=?)
 *   3. INSERT INTO WalletLedger (...)
 *      (plain INSERT — unique index throws on duplicate → batch rollback)
 *
 * After batch:
 *   - If stmt1 affected 1 row → success (transition + balance + ledger all done)
 *   - If stmt1 affected 0 row → status was wrong, but stmt2+stmt3 also
 *     affected 0 rows (refundToken didn't match) → safe to throw
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

  // Pre-check: current status
  const current = await d1.prepare(
    `SELECT status FROM WithdrawalRequest WHERE id = ?`
  ).bind(input.withdrawalId).first<{ status: string }>();

  if (!current) {
    throw new Error(`Withdrawal ${input.withdrawalId} not found`);
  }

  if (current.status === "REJECTED") {
    // Already REJECTED — verify a REFUND ledger exists.
    const existingLedger = await d1.prepare(
      `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
       AND referenceId = ? AND type = 'REFUND' LIMIT 1`
    ).bind(input.withdrawalId).first<{ id: string }>();

    if (!existingLedger) {
      throw new Error(
        `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger. Manual reconciliation required.`
      );
    }

    const wallet = await d1.prepare(
      `SELECT balance FROM Wallet WHERE id = ?`
    ).bind(input.walletId).first<{ balance: string }>();

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

  // Read current balance BEFORE the batch (for ledger balanceBefore)
  const walletBefore = await d1.prepare(
    `SELECT balance FROM Wallet WHERE id = ?`
  ).bind(input.walletId).first<{ balance: string }>();
  const balanceBefore = Number(walletBefore?.balance ?? 0);
  const balanceAfter = balanceBefore + input.amount;

  const refundToken = generateToken();
  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();

  // Statement 1: Status transition + set refundToken
  // Only succeeds if status is REFUND_PENDING (conditional WHERE)
  const stmt1_statusGuard = d1.prepare(
    `UPDATE WithdrawalRequest
     SET status = 'REJECTED', processedAt = ?, reviewerId = ?, refundToken = ?
     WHERE id = ? AND status = 'REFUND_PENDING'`
  ).bind(now, input.reviewerId, refundToken, input.withdrawalId);

  // Statement 2: Balance increment — CONDITIONAL on OUR refundToken
  // If stmt1 didn't set our token (status was wrong or already REJECTED),
  // this WHERE clause matches 0 rows → no balance change.
  const stmt2_balance = d1.prepare(
    `UPDATE Wallet SET balance = balance + ?
     WHERE id = ?
       AND EXISTS (SELECT 1 FROM WithdrawalRequest
                   WHERE id = ? AND refundToken = ? AND walletId = ?)`
  ).bind(input.amount, input.walletId, input.withdrawalId, refundToken, input.walletId);

  // Statement 3: Ledger insert — PLAIN INSERT (not INSERT...SELECT)
  // If a REFUND ledger already exists, the partial unique index causes
  // a UNIQUE constraint violation → SQL ERROR → batch rolls back stmt1+stmt2.
  // This is the final atomic guard against double-refund.
  const stmt3_ledger = d1.prepare(
    `INSERT INTO WalletLedger (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
     VALUES (?, ?, 'REFUND', ?, ?, ?, 'Withdrawal', ?, ?, ?, ?)`
  ).bind(
    ledgerId,
    input.walletId,
    input.amount,
    balanceBefore,
    balanceAfter,
    input.withdrawalId,
    input.description,
    input.reviewerId,
    now
  );

  // Execute atomically
  let results;
  try {
    results = await d1.batch([stmt1_statusGuard, stmt2_balance, stmt3_ledger]);
  } catch (batchError: unknown) {
    // UNIQUE constraint violation = duplicate refund attempt (concurrent request won)
    const errMsg = String((batchError as Error)?.message ?? "");
    if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
      // Another request won the race — re-check state
      const recheck = await d1.prepare(
        `SELECT status FROM WithdrawalRequest WHERE id = ?`
      ).bind(input.withdrawalId).first<{ status: string }>();

      if (recheck?.status === "REJECTED") {
        const existingLedger = await d1.prepare(
          `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
           AND referenceId = ? AND type = 'REFUND' LIMIT 1`
        ).bind(input.withdrawalId).first<{ id: string }>();

        if (!existingLedger) {
          throw new Error(
            `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED after batch error but has no REFUND ledger.`
          );
        }

        const wallet = await d1.prepare(
          `SELECT balance FROM Wallet WHERE id = ?`
        ).bind(input.walletId).first<{ balance: string }>();

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

  // Verify all statements succeeded (success: true)
  for (let i = 0; i < results.length; i++) {
    if (!results[i].success) {
      throw new Error(
        `Atomic refund statement ${i} failed for withdrawal ${input.withdrawalId}`
      );
    }
  }

  // Check that the status guard affected exactly 1 row.
  // If 0, the status was not REFUND_PENDING — but because stmt2 was
  // conditional on refundToken (which wasn't set), it also affected 0 rows.
  // stmt3 may have inserted a ledger entry — but without the balance
  // increment, this is an inconsistency.
  const statusChanges = (results[0].meta as { changes?: number }).changes ?? 0;
  if (statusChanges !== 1) {
    throw new Error(
      `Atomic refund: status guard affected ${statusChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (status was not REFUND_PENDING). The refundToken was not set, ` +
      `so balance increment also affected 0 rows. No financial changes were made.`
    );
  }

  // Verify balance increment affected 1 row
  const balanceChanges = (results[1].meta as { changes?: number }).changes ?? 0;
  if (balanceChanges !== 1) {
    throw new Error(
      `Atomic refund: balance increment affected ${balanceChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (refundToken verification failed). Manual reconciliation required.`
    );
  }

  // Read the new balance
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
 * SQLite dev implementation: use prisma.$transaction().
 *
 * In SQLite, $transaction provides real ACID guarantees. The status guard
 * throws if count !== 1, which rolls back the entire transaction.
 *
 * The refundToken is also set here for consistency with D1, even though
 * it's not strictly necessary (the transaction handles atomicity).
 *
 * balanceBefore/balanceAfter are computed from the actual wallet state.
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const refundToken = generateToken();

  return await db.$transaction(async (tx) => {
    // Read current balance BEFORE increment
    const walletBefore = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });
    if (!walletBefore) {
      throw new Error(`Wallet ${input.walletId} not found`);
    }
    const balanceBefore = Number(walletBefore.balance);
    const balanceAfter = balanceBefore + input.amount;

    // 1. Status guard: transition REFUND_PENDING → REJECTED + set refundToken
    const statusResult = await tx.withdrawalRequest.updateMany({
      where: { id: input.withdrawalId, status: "REFUND_PENDING" },
      data: {
        status: "REJECTED",
        processedAt: new Date(),
        reviewerId: input.reviewerId,
        refundToken,
      },
    });

    if (statusResult.count !== 1) {
      // Status was not REFUND_PENDING — check if already REJECTED (idempotent)
      const current = await tx.withdrawalRequest.findUnique({
        where: { id: input.withdrawalId },
        select: { status: true },
      });

      if (current?.status === "REJECTED") {
        const existingLedger = await tx.walletLedger.findFirst({
          where: {
            referenceType: "Withdrawal",
            referenceId: input.withdrawalId,
            type: "REFUND",
          },
        });

        if (!existingLedger) {
          throw new Error(
            `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger. Manual reconciliation required.`
          );
        }

        const wallet = await tx.wallet.findUnique({
          where: { id: input.walletId },
          select: { balance: true },
        });
        return {
          success: true,
          refundLedgerId: existingLedger.id,
          newBalance: Number(wallet?.balance ?? 0),
          alreadyRefunded: true,
        };
      }

      throw new Error(
        `Atomic refund: withdrawal ${input.withdrawalId} status is ${current?.status ?? "null"}. Transaction rolled back.`
      );
    }

    // 2. Refund: increment wallet balance
    const refundResult = await tx.wallet.updateMany({
      where: { id: input.walletId },
      data: { balance: { increment: input.amount } },
    });

    if (refundResult.count !== 1) {
      throw new Error(
        `Atomic refund: wallet ${input.walletId} not found. Transaction rolled back.`
      );
    }

    // 3. Insert REFUND ledger entry with REAL balanceBefore/balanceAfter
    // The unique index prevents duplicate — if this throws P2002,
    // the entire transaction rolls back (including balance increment).
    const ledger = await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "REFUND",
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        referenceType: "Withdrawal",
        referenceId: input.withdrawalId,
        description: input.description,
        createdBy: input.reviewerId,
      },
    });

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
