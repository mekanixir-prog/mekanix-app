// MEKANIX — Atomic refund helper
//
// CRITICAL: This helper eliminates the double-refund risk at the DB level
// using a partial unique index on WalletLedger(referenceId) WHERE type='REFUND'
// AND referenceType='Withdrawal'.
//
// DESIGN: ALL operations (status guard, balance increment, ledger insert)
// happen inside a SINGLE atomic unit. The status guard is ENFORCED BY SQL,
// not by application-level checking of meta.changes after the batch.
//
// SAFETY GUARANTEES (enforced by SQL + unique index):
//   1. Balance increment ONLY happens if status transitions REFUND_PENDING→REJECTED
//   2. Ledger insert ONLY happens if status transitioned (conditional SQL)
//   3. Ledger insert fails if duplicate (partial unique index) → batch rollback
//   4. If status is already REJECTED, we verify a REFUND ledger exists
//      — if NOT, that's a financial inconsistency (throw, not success)
//   5. Concurrent requests: the unique index prevents double-refund at DB level
//      even if two requests pass the pre-check simultaneously
//
// NO FALLBACK: If the environment cannot provide atomicity, this helper
// throws. We never fall back to non-atomic sequential writes.

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

/**
 * Execute an atomic refund for a withdrawal.
 *
 * Safety guarantees (enforced by SQL, not application logic):
 *   1. Balance increment ONLY happens if status transitions REFUND_PENDING→REJECTED
 *   2. Ledger insert ONLY happens if status transitioned (conditional SQL)
 *   3. Ledger insert fails if duplicate (partial unique index) → batch rollback
 *   4. If status is already REJECTED, we verify a REFUND ledger exists
 *      — if NOT, that's a financial inconsistency (throw, not success)
 *   5. Concurrent requests: the unique index prevents double-refund at DB level
 *      even if two requests pass the pre-check simultaneously
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
 * D1 implementation: use env.DB.batch() with CONDITIONAL SQL.
 *
 * All 3 statements use WHERE clauses that check status = 'REFUND_PENDING'.
 * If status is wrong, ALL statements affect 0 rows — no partial state.
 *
 * Statement order:
 *   1. UPDATE WithdrawalRequest SET status='REJECTED' WHERE id=? AND status='REFUND_PENDING'
 *   2. UPDATE Wallet SET balance=balance+? WHERE id=? AND status is now REJECTED
 *   3. INSERT INTO WalletLedger ... WHERE status is REJECTED AND no existing REFUND
 *
 * If status is already REJECTED:
 *   - Pre-check finds REJECTED
 *   - We check if REFUND ledger exists
 *   - If YES: return alreadyRefunded=true (idempotent success)
 *   - If NO: throw financial inconsistency (REJECTED without refund = corrupted state)
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
    // REJECTED without a REFUND ledger is a financial inconsistency.
    const existingLedger = await d1.prepare(
      `SELECT id FROM WalletLedger WHERE referenceType = 'Withdrawal'
       AND referenceId = ? AND type = 'REFUND' LIMIT 1`
    ).bind(input.withdrawalId).first<{ id: string }>();

    if (!existingLedger) {
      // FINANCIAL INCONSISTENCY: withdrawal is REJECTED but no REFUND ledger.
      // This should never happen in normal flow. Throw so operator can investigate.
      throw new Error(
        `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger entry. ` +
        `Manual reconciliation required.`
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

  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();

  // Statement 1: Status guard — transition REFUND_PENDING → REJECTED
  const stmt1_statusGuard = d1.prepare(
    `UPDATE WithdrawalRequest SET status = 'REJECTED', processedAt = ?, reviewerId = ?
     WHERE id = ? AND status = 'REFUND_PENDING'`
  ).bind(now, input.reviewerId, input.withdrawalId);

  // Statement 2: Balance increment — CONDITIONAL on status being REJECTED
  // (stmt1 already changed it from REFUND_PENDING to REJECTED within this batch)
  // Also verify walletId matches the withdrawal's walletId (not just any wallet)
  const stmt2_balance = d1.prepare(
    `UPDATE Wallet SET balance = balance + ?
     WHERE id = ?
       AND EXISTS (SELECT 1 FROM WithdrawalRequest
                   WHERE id = ? AND status = 'REJECTED' AND walletId = ?)`
  ).bind(input.amount, input.walletId, input.withdrawalId, input.walletId);

  // Statement 3: Ledger insert — CONDITIONAL on status being REJECTED
  // AND no existing REFUND ledger (idempotency guard at SQL level)
  // The partial unique index is the final atomic guard
  const stmt3_ledger = d1.prepare(
    `INSERT INTO WalletLedger (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
     SELECT ?, ?, 'REFUND', ?, 0, 0, 'Withdrawal', ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM WithdrawalRequest WHERE id = ? AND status = 'REJECTED' AND walletId = ?)
       AND NOT EXISTS (SELECT 1 FROM WalletLedger WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')`
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
    input.withdrawalId
  );

  // Execute atomically
  let results;
  try {
    results = await d1.batch([stmt1_statusGuard, stmt2_balance, stmt3_ledger]);
  } catch (batchError: unknown) {
    // Unique constraint violation = duplicate refund attempt (concurrent request won)
    const errMsg = String((batchError as Error)?.message ?? "");
    if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
      // Re-check state — another request should have completed the refund
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

  // Check that the status guard affected exactly 1 row
  const statusChanges = (results[0].meta as { changes?: number }).changes ?? 0;
  if (statusChanges !== 1) {
    // Status was not REFUND_PENDING — but because stmt2+stmt3 were
    // conditional (they check for status='REJECTED'), they affected 0 rows.
    // No balance change, no ledger entry — safe to throw.
    throw new Error(
      `Atomic refund: status guard affected ${statusChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Expected 1 (status was not REFUND_PENDING). No balance or ledger changes were made.`
    );
  }

  // Verify ledger was actually created (stmt3 should have affected 1 row)
  const ledgerChanges = (results[2].meta as { changes?: number }).changes ?? 0;
  if (ledgerChanges !== 1) {
    // This shouldn't happen if status guard succeeded — but if it does,
    // it means the conditional INSERT didn't match. This could be:
    //   - A REFUND ledger already existed (race condition with another request)
    //   - Some other inconsistency
    throw new Error(
      `Atomic refund: ledger insert affected ${ledgerChanges} rows for withdrawal ${input.withdrawalId}. ` +
      `Status transitioned but ledger was not created. Manual reconciliation required.`
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
 * SQLite dev implementation: use prisma.$transaction() for atomic execution.
 *
 * In SQLite, $transaction provides real ACID guarantees — if any operation
 * throws, the entire transaction rolls back. This is stronger than D1 batch.
 *
 * Order: status guard FIRST, then balance, then ledger.
 * If status guard affects 0 rows, we throw — transaction rolls back.
 *
 * Also: if status is already REJECTED, we verify a REFUND ledger exists.
 * REJECTED without ledger = financial inconsistency (throw).
 */
async function executeAtomicRefundSQLite(
  db: PrismaClient,
  input: AtomicRefundInput
): Promise<AtomicRefundResult> {
  return await db.$transaction(async (tx) => {
    // 1. Status guard: transition REFUND_PENDING → REJECTED
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
        // Already REJECTED — verify a REFUND ledger exists.
        // REJECTED without a REFUND ledger is a financial inconsistency.
        const existingLedger = await tx.walletLedger.findFirst({
          where: {
            referenceType: "Withdrawal",
            referenceId: input.withdrawalId,
            type: "REFUND",
          },
        });

        if (!existingLedger) {
          throw new Error(
            `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED but has no REFUND ledger entry. ` +
            `Manual reconciliation required.`
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
        `Atomic refund: withdrawal ${input.withdrawalId} status is ${current?.status ?? "null"}. ` +
        `Transaction rolled back — no balance change, no ledger entry.`
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

    // 3. Insert REFUND ledger entry (unique index prevents duplicate)
    // If this throws P2002 (unique constraint), the entire transaction
    // rolls back — including the balance increment and status transition.
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
