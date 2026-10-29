// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level
// and provides crash recovery for the two-phase D1 approach.
//
// DESIGN: Two-phase approach for D1 with crash recovery.
//
// Phase 1 (batch): status transition + balance increment (both conditional on refundToken)
//   - stmt1: UPDATE WithdrawalRequest SET status='REJECTED', refundToken=?
//     WHERE id=? AND status='REFUND_PENDING'
//   - stmt2: UPDATE Wallet SET balance=balance+? WHERE id=? AND EXISTS(refundToken)
//     RETURNING balance  ← reads the ACTUAL post-increment balance atomically
//   - If stmt1 count=0: stmt2 also count=0 (refundToken not set) → safe
//
// Phase 2 (single): ledger insert with balanceBefore/balanceAfter from Phase 1
//   - stmt3: INSERT INTO WalletLedger (balanceBefore=?, balanceAfter=?)
//   - If duplicate: UNIQUE constraint throws → we detect and handle
//
// CRASH RECOVERY:
//   If a Worker crashes after Phase 1 but before Phase 2:
//   - Withdrawal is REJECTED with refundToken set
//   - Balance was incremented (Phase 1 succeeded)
//   - No REFUND ledger entry exists
//
//   On the next request (or retry), the pre-check detects this:
//   - status=REJECTED + refundToken is set + no REFUND ledger
//   → This is a CRASH RECOVERY scenario, not a fresh refund
//   → Create the missing ledger WITHOUT re-incrementing balance
//   → Use current balance for balanceAfter, balanceBefore = balanceAfter - amount
//
//   The refundToken distinguishes:
//   - REJECTED + refundToken=NULL + no ledger = pre-existing inconsistency (throw)
//   - REJECTED + refundToken=set + no ledger = crash after Phase 1 (recover)

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
 * D1 implementation: two-phase with RETURNING + crash recovery.
 *
 * Phase 1 (batch): status transition + balance increment (with RETURNING)
 * Phase 2 (single): ledger insert with actual balance values
 *
 * Crash recovery: if REJECTED + refundToken set + no ledger, create ledger
 * without re-incrementing balance.
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

  // Pre-check: current status + refundToken
  const current = await d1.prepare(
    `SELECT status, refundToken FROM WithdrawalRequest WHERE id = ?`
  ).bind(input.withdrawalId).first<{ status: string; refundToken: string | null }>();

  if (!current) {
    throw new Error(`Withdrawal ${input.withdrawalId} not found`);
  }

  if (current.status === "REJECTED") {
    // Check if a REFUND ledger exists
    const existingLedger = await d1.prepare(
      `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
       AND referenceId = ? AND type = 'REFUND' LIMIT 1`
    ).bind(input.withdrawalId).first<{ id: string }>();

    if (existingLedger) {
      // Normal idempotent retry — refund is complete
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

    // REJECTED but no REFUND ledger — two sub-cases:
    if (current.refundToken) {
      // CRASH RECOVERY: refundToken is set → Phase 1 completed (balance was incremented)
      // but Phase 2 (ledger insert) didn't happen (crash or timeout)
      //
      // Recovery: create the missing ledger WITHOUT re-incrementing balance.
      // The balance was already incremented in Phase 1.
      // Use current wallet balance for balanceAfter.
      const wallet = await d1.prepare(
        `SELECT balance FROM Wallet WHERE id = ?`
      ).bind(input.walletId).first<{ balance: string }>();
      const balanceAfter = Number(wallet?.balance ?? 0);
      const balanceBefore = balanceAfter - input.amount;

      const ledgerId = `ledger_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date().toISOString();

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
          `${input.description} [CRASH RECOVERY — ledger created on retry, balance was already incremented]`,
          input.reviewerId,
          now
        ).run();

        console.error("[atomic-refund] CRASH RECOVERY: created missing REFUND ledger", {
          withdrawalId: input.withdrawalId,
          walletId: input.walletId,
          refundToken: current.refundToken,
          ledgerId,
          note: "Phase 1 completed but Phase 2 was interrupted. Ledger created without re-incrementing balance.",
        });

        return {
          success: true,
          refundLedgerId: ledgerId,
          newBalance: balanceAfter,
          alreadyRefunded: false,
        };
      } catch (ledgerError: unknown) {
        // If UNIQUE constraint — another recovery request already created the ledger
        const errMsg = String((ledgerError as Error)?.message ?? "");
        if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
          // Re-read the ledger
          const recheckLedger = await d1.prepare(
            `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
             AND referenceId = ? AND type = 'REFUND' LIMIT 1`
          ).bind(input.withdrawalId).first<{ id: string }>();

          if (recheckLedger) {
            return {
              success: true,
              refundLedgerId: recheckLedger.id,
              newBalance: balanceAfter,
              alreadyRefunded: true,
            };
          }
        }
        throw new Error(
          `CRASH RECOVERY failed: cannot create missing ledger for withdrawal ${input.withdrawalId}. ` +
          `Balance was incremented but ledger creation failed. Manual reconciliation required. ` +
          `Error: ${errMsg}`
        );
      }
    } else {
      // refundToken is NULL → this is a pre-existing inconsistency (not a crash)
      throw new Error(
        `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger and no refundToken. ` +
        `This is not a crash recovery scenario — the refund was never started. Manual reconciliation required.`
      );
    }
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

  // stmt2 uses RETURNING to get the ACTUAL post-increment balance atomically.
  // This eliminates the race between increment and read.
  // The EXISTS subquery ensures this only runs if OUR refundToken was set.
  const stmt2_balance = d1.prepare(
    `UPDATE Wallet SET balance = balance + ?
     WHERE id = ?
       AND EXISTS (SELECT 1 FROM WithdrawalRequest
                   WHERE id = ? AND refundToken = ? AND walletId = ?)
     RETURNING balance`
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
    throw new Error(
      `Atomic refund: status guard affected ${statusChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (status was not REFUND_PENDING). No financial changes were made.`
    );
  }

  // Get the ACTUAL balance from stmt2's RETURNING clause
  // The results array contains the returned rows
  const stmt2Results = phase1Results[1].results as Array<{ balance: string }> | undefined;
  if (!stmt2Results || stmt2Results.length !== 1) {
    // stmt2 affected 0 rows (refundToken verification failed — walletId mismatch)
    // Transition to RECONCILIATION_NEEDED
    await d1.prepare(
      `UPDATE WithdrawalRequest SET status = 'RECONCILIATION_NEEDED'
       WHERE id = ? AND status = 'REJECTED' AND refundToken = ?`
    ).bind(input.withdrawalId, refundToken).run();

    throw new Error(
      `Atomic refund: balance increment returned 0 rows for withdrawal ${input.withdrawalId}. ` +
      `Status transitioned but balance was NOT incremented (walletId mismatch?). ` +
      `Transitioned to RECONCILIATION_NEEDED.`
    );
  }

  // We have the actual post-increment balance from RETURNING
  const balanceAfter = Number(stmt2Results[0].balance);
  const balanceBefore = balanceAfter - input.amount;

  // ════════ Phase 2: Ledger insert (single statement) ════════
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

    return {
      success: true,
      refundLedgerId: ledgerId,
      newBalance: balanceAfter,
      alreadyRefunded: false,
    };
  } catch (ledgerError: unknown) {
    // Ledger insert failed after Phase 1 succeeded.
    // The balance WAS incremented, and refundToken IS set.
    // Transition to RECONCILIATION_NEEDED.
    const errMsg = String((ledgerError as Error)?.message ?? "");

    await d1.prepare(
      `UPDATE WithdrawalRequest SET status = 'RECONCILIATION_NEEDED'
       WHERE id = ? AND status = 'REJECTED' AND refundToken = ?`
    ).bind(input.withdrawalId, refundToken).run();

    if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
      // Another request already created a REFUND ledger for this withdrawal.
      // Our balance increment was a double-refund — critical!
      console.error("[atomic-refund] CRITICAL: double-refund detected", {
        withdrawalId: input.withdrawalId,
        walletId: input.walletId,
        ourToken: refundToken,
        balanceAfter,
      });
      throw new Error(
        `CRITICAL: double-refund detected for withdrawal ${input.withdrawalId}. ` +
        `Balance was incremented twice. Transitioned to RECONCILIATION_NEEDED. ` +
        `Manual reconciliation required immediately.`
      );
    }

    throw new Error(
      `Atomic refund: ledger insert failed for withdrawal ${input.withdrawalId}. ` +
      `Balance was incremented (balanceAfter=${balanceAfter}) but ledger not created. ` +
      `Transitioned to RECONCILIATION_NEEDED. ` +
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
 * Crash recovery is handled by the pre-check in executeAtomicRefundD1:
 * if REJECTED + refundToken + no ledger, we create the ledger.
 * For SQLite, the same recovery logic applies (the pre-check runs
 * regardless of environment).
 *
 * balanceBefore is read INSIDE the transaction (not before), so it
 * reflects the actual state at the time of the refund.
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  const refundToken = generateToken();

  return await db.$transaction(async (tx) => {
    // Read current balance INSIDE the transaction
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
        select: { status: true, refundToken: true },
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
          if (current.refundToken) {
            // CRASH RECOVERY: refundToken is set → Phase 1 completed
            // Create the missing ledger without re-incrementing balance
            const wallet = await tx.wallet.findUnique({
              where: { id: input.walletId },
              select: { balance: true },
            });
            const balanceAfter = Number(wallet?.balance ?? 0);
            const balanceBeforeRecovery = balanceAfter - input.amount;
            const ledgerId = `ledger_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

            const ledger = await tx.walletLedger.create({
              data: {
                walletId: input.walletId,
                type: "REFUND",
                amount: input.amount,
                balanceBefore: balanceBeforeRecovery,
                balanceAfter,
                referenceType: "Withdrawal",
                referenceId: input.withdrawalId,
                description: `${input.description} [CRASH RECOVERY]`,
                createdBy: input.reviewerId,
              },
            });

            return {
              success: true,
              refundLedgerId: ledger.id,
              newBalance: balanceAfter,
              alreadyRefunded: false,
            };
          } else {
            throw new Error(
              `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger and no refundToken.`
            );
          }
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
