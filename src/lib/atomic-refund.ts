// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level.
//
// DESIGN: Uses a two-phase approach for D1:
//
// Phase 1 (batch): status transition + balance increment
//   - stmt1: UPDATE WithdrawalRequest SET status='REJECTED', refundToken=?
//     WHERE id=? AND status='REFUND_PENDING'
//   - stmt2: UPDATE Wallet SET balance=balance+?
//     WHERE id=? AND EXISTS(... refundToken=?)
//   - If stmt1 count=0: stmt2 also count=0 (refundToken not set) → safe
//   - If stmt1 count=1: stmt2 count=1 → balance incremented
//
// Phase 2 (single statement): ledger insert
//   - stmt3: INSERT INTO WalletLedger (...)
//     This is a PLAIN INSERT — if a REFUND ledger already exists,
//     the partial unique index throws UNIQUE constraint violation.
//   - If stmt3 succeeds: refund is complete (balance + ledger + status all done)
//   - If stmt3 fails (UNIQUE): another request won the race.
//     The balance was incremented by Phase 1, but the ledger failed.
//     We transition to RECONCILIATION_NEEDED for manual reconciliation.
//
// Why two phases?
//   D1 batch() does NOT roll back when a statement affects 0 rows.
//   If stmt3 is INSERT...SELECT with WHERE refundToken=?, it could
//   silently insert 0 rows (if refundToken doesn't match) — without
//   triggering the unique index. This would leave the balance
//   incremented but no ledger entry — a financial inconsistency.
//
//   With two phases:
//   - Phase 1 either fully succeeds (balance incremented) or fully
//     does nothing (0 rows affected).
//   - Phase 2 either succeeds (ledger created) or throws (unique violation).
//   - If Phase 2 throws after Phase 1 succeeded, we know the balance
//     WAS incremented but ledger failed → RECONCILIATION_NEEDED.
//
// balanceBefore/balanceAfter:
//   For D1: read balance AFTER Phase 1 (the actual post-increment balance).
//   Then compute balanceBefore = newBalance - amount.
//   This ensures the ledger reflects the actual state at the time of insert.
//
// For SQLite dev: $transaction provides real ACID, so single-phase works.

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
 * D1 implementation: two-phase approach.
 *
 * Phase 1 (batch): status transition + balance increment (both conditional on refundToken)
 * Phase 2 (single): ledger insert (plain INSERT — unique index throws on duplicate)
 *
 * If Phase 1 succeeds (stmt1 count=1) but Phase 2 fails (unique violation):
 *   - Balance WAS incremented, but no ledger entry
 *   - Transition to RECONCILIATION_NEEDED
 *   - The unique index on WalletLedger ensures only ONE refund ledger per withdrawal
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

  const refundToken = generateToken();
  const now = new Date().toISOString();

  // ════════ Phase 1: Status transition + balance increment (batch) ════════

  const stmt1_statusGuard = d1.prepare(
    `UPDATE WithdrawalRequest
     SET status = 'REJECTED', processedAt = ?, reviewerId = ?, refundToken = ?
     WHERE id = ? AND status = 'REFUND_PENDING'`
  ).bind(now, input.reviewerId, refundToken, input.withdrawalId);

  const stmt2_balance = d1.prepare(
    `UPDATE Wallet SET balance = balance + ?
     WHERE id = ?
       AND EXISTS (SELECT 1 FROM WithdrawalRequest
                   WHERE id = ? AND refundToken = ? AND walletId = ?)`
  ).bind(input.amount, input.walletId, input.withdrawalId, refundToken, input.walletId);

  const phase1Results = await d1.batch([stmt1_statusGuard, stmt2_balance]);

  // Verify Phase 1 succeeded
  for (let i = 0; i < phase1Results.length; i++) {
    if (!phase1Results[i].success) {
      throw new Error(
        `Atomic refund Phase 1 statement ${i} failed for withdrawal ${input.withdrawalId}`
      );
    }
  }

  const statusChanges = (phase1Results[0].meta as { changes?: number }).changes ?? 0;
  if (statusChanges !== 1) {
    // Status was not REFUND_PENDING — stmt2 also affected 0 rows (refundToken not set).
    // No balance change, no ledger entry — safe to throw.
    throw new Error(
      `Atomic refund: status guard affected ${statusChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (status was not REFUND_PENDING). No financial changes were made.`
    );
  }

  const balanceChanges = (phase1Results[1].meta as { changes?: number }).changes ?? 0;
  if (balanceChanges !== 1) {
    // refundToken verification failed — walletId mismatch or wallet not found.
    // stmt1 DID transition to REJECTED, but balance was NOT incremented.
    // This is a financial inconsistency — transition to RECONCILIATION_NEEDED.
    await d1.prepare(
      `UPDATE WithdrawalRequest SET status = 'RECONCILIATION_NEEDED'
       WHERE id = ? AND status = 'REJECTED' AND refundToken = ?`
    ).bind(input.withdrawalId, refundToken).run();

    throw new Error(
      `Atomic refund: balance increment affected ${balanceChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Status transitioned but balance was NOT incremented (walletId mismatch?). ` +
      `Transitioned to RECONCILIATION_NEEDED. Manual reconciliation required.`
    );
  }

  // ════════ Phase 2: Ledger insert (single statement) ════════
  //
  // Read the ACTUAL balance after increment (not computed before batch).
  // This ensures balanceBefore/balanceAfter reflect the real state.
  const walletAfter = await d1.prepare(
    `SELECT balance FROM Wallet WHERE id = ?`
  ).bind(input.walletId).first<{ balance: string }>();
  const balanceAfter = Number(walletAfter?.balance ?? 0);
  const balanceBefore = balanceAfter - input.amount;

  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  try {
    await d1.prepare(
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
    ).run();

    // Phase 2 succeeded — refund is complete.
    return {
      success: true,
      refundLedgerId: ledgerId,
      newBalance: balanceAfter,
      alreadyRefunded: false,
    };
  } catch (ledgerError: unknown) {
    // Ledger insert failed. This could be:
    //   - UNIQUE constraint violation (another request already created a REFUND ledger)
    //   - Other SQL error
    //
    // The balance WAS incremented in Phase 1, but the ledger failed.
    // This is a financial inconsistency — transition to RECONCILIATION_NEEDED.
    const errMsg = String((ledgerError as Error)?.message ?? "");

    await d1.prepare(
      `UPDATE WithdrawalRequest SET status = 'RECONCILIATION_NEEDED'
       WHERE id = ? AND status = 'REJECTED' AND refundToken = ?`
    ).bind(input.withdrawalId, refundToken).run();

    if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
      // Another request won the race for ledger insert.
      // Check if a REFUND ledger exists now.
      const existingLedger = await d1.prepare(
        `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
         AND referenceId = ? AND type = 'REFUND' LIMIT 1`
      ).bind(input.withdrawalId).first<{ id: string }>();

      if (existingLedger) {
        // Another request's refund is complete. Our balance increment
        // was a DOUBLE-REFUND — the other request already incremented.
        // This is the scenario refundToken was supposed to prevent.
        // If we reach here, refundToken didn't work as expected.
        console.error("[atomic-refund] CRITICAL: double-refund detected despite refundToken", {
          withdrawalId: input.withdrawalId,
          walletId: input.walletId,
          ourToken: refundToken,
        });
        throw new Error(
          `CRITICAL: double-refund detected for withdrawal ${input.withdrawalId}. ` +
          `Balance was incremented twice. Transitioned to RECONCILIATION_NEEDED. ` +
          `Manual reconciliation required immediately.`
        );
      }
    }

    throw new Error(
      `Atomic refund: ledger insert failed for withdrawal ${input.withdrawalId}. ` +
      `Balance was incremented but ledger not created. ` +
      `Transitioned to RECONCILIATION_NEEDED. Manual reconciliation required. ` +
      `Error: ${errMsg}`
    );
  }
}

/**
 * SQLite dev implementation: use prisma.$transaction().
 *
 * In SQLite, $transaction provides real ACID guarantees. All operations
 * run in a single transaction — if any throws, everything rolls back.
 *
 * balanceBefore is read inside the transaction, so it reflects the
 * actual state at the time of the refund (not before the transaction).
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const refundToken = generateToken();

  return await db.$transaction(async (tx) => {
    // Read current balance INSIDE the transaction (not before)
    const walletBefore = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });
    if (!walletBefore) {
      throw new Error(`Wallet ${input.walletId} not found`);
    }
    const balanceBefore = Number(walletBefore.balance);

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
    const balanceAfter = balanceBefore + input.amount;
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
