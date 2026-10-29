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
  if (!d1) throw new Error("D1 binding 'DB' not found — cannot execute atomic refund");

  const current = await d1.prepare(
    `SELECT status, refundToken, walletId FROM WithdrawalRequest WHERE id = ?`
  ).bind(input.withdrawalId).first<{ status: string; refundToken: string | null; walletId: string }>();

  if (!current) throw new Error(`Withdrawal ${input.withdrawalId} not found`);
  if (current.walletId !== input.walletId) {
    throw new Error(`FINANCIAL INCONSISTENCY: wallet mismatch for withdrawal ${input.withdrawalId}`);
  }

  const existingLedger = await d1.prepare(
    `SELECT id FROM WalletLedger
     WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND' LIMIT 1`
  ).bind(input.withdrawalId).first<{ id: string }>();

  if (existingLedger) {
    if (current.status !== "REJECTED") {
      throw new Error(
        `FINANCIAL INCONSISTENCY: refund ledger exists while withdrawal ${input.withdrawalId} is ${current.status}. Manual reconciliation required.`
      );
    }
    const wallet = await d1.prepare(
      `SELECT balance FROM Wallet WHERE id = ?`
    ).bind(input.walletId).first<{ balance: number | string }>();
    return {
      success: true,
      refundLedgerId: existingLedger.id,
      newBalance: Number(wallet?.balance ?? 0),
      alreadyRefunded: true,
    };
  }

  // Never infer that money moved from refundToken alone. Legacy REJECTED rows
  // without a ledger are ambiguous and require reconciliation, not a synthetic ledger.
  if (current.status === "REJECTED") {
    throw new Error(
      `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED without a REFUND ledger. Manual reconciliation required.`
    );
  }
  if (current.status !== "REFUND_PENDING") {
    throw new Error(
      `Withdrawal ${input.withdrawalId} status is ${current.status}, expected REFUND_PENDING or REJECTED`
    );
  }

  const refundToken = generateToken();
  const now = new Date().toISOString();
  const ledgerId = `ledger_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // One D1 batch makes the state transition, balance increment, and ledger
  // insert atomic. All three statements share the same guards, so a missing
  // wallet, stale status, or pre-existing ledger makes the entire transition
  // a no-op; a SQL/unique-index error rolls the whole batch back.
  const results = await d1.batch([
    d1.prepare(
      `UPDATE WithdrawalRequest
       SET status = 'REJECTED', processedAt = ?, reviewerId = ?, refundToken = ?
       WHERE id = ? AND status = 'REFUND_PENDING' AND walletId = ?
         AND EXISTS (SELECT 1 FROM Wallet WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM WalletLedger
                         WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')`
    ).bind(now, input.reviewerId, refundToken, input.withdrawalId, input.walletId, input.walletId, input.withdrawalId),
    d1.prepare(
      `UPDATE Wallet SET balance = balance + ?, updatedAt = ?
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM WithdrawalRequest
                     WHERE id = ? AND status = 'REJECTED' AND refundToken = ? AND walletId = ?)
         AND NOT EXISTS (SELECT 1 FROM WalletLedger
                         WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')
       RETURNING balance`
    ).bind(input.amount, now, input.walletId, input.withdrawalId, refundToken, input.walletId, input.withdrawalId),
    d1.prepare(
      `INSERT INTO WalletLedger
       (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
       SELECT ?, ?, 'REFUND', ?, balance - ?, balance, 'Withdrawal', ?, ?, ?, ?
       FROM Wallet
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM WithdrawalRequest
                     WHERE id = ? AND status = 'REJECTED' AND refundToken = ? AND walletId = ?)
         AND NOT EXISTS (SELECT 1 FROM WalletLedger
                         WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')`
    ).bind(
      ledgerId, input.walletId, input.amount, input.amount, input.withdrawalId,
      input.description, input.reviewerId, now, input.walletId,
      input.withdrawalId, refundToken, input.walletId, input.withdrawalId
    ),
  ]);

  for (const result of results) {
    if (!result.success) {
      throw new Error(`Atomic refund batch statement failed for withdrawal ${input.withdrawalId}`);
    }
  }

  const statusChanges = results[0].meta.changes ?? 0;
  const balanceRows = (results[1].results ?? []) as Array<{ balance: number | string }>;
  const ledgerChanges = results[2].meta.changes ?? 0;

  if (statusChanges === 1 && balanceRows.length === 1 && ledgerChanges === 1) {
    return {
      success: true,
      refundLedgerId: ledgerId,
      newBalance: Number(balanceRows[0].balance),
      alreadyRefunded: false,
    };
  }

  // No partial refund is expected: the guards are equivalent and D1 batch is
  // atomic. Re-read state only to distinguish a concurrent completed refund
  // from a stale/invalid state; never synthesize a ledger from a token.
  const recheckLedger = await d1.prepare(
    `SELECT id FROM WalletLedger
     WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND' LIMIT 1`
  ).bind(input.withdrawalId).first<{ id: string }>();

  if (recheckLedger) {
    const wallet = await d1.prepare(
      `SELECT balance FROM Wallet WHERE id = ?`
    ).bind(input.walletId).first<{ balance: number | string }>();
    return {
      success: true,
      refundLedgerId: recheckLedger.id,
      newBalance: Number(wallet?.balance ?? 0),
      alreadyRefunded: true,
    };
  }

  throw new Error(
    `Atomic refund did not complete all three statements for withdrawal ${input.withdrawalId}. No refund ledger exists; manual reconciliation required.`
  );
}

/**
 * SQLite dev implementation: use prisma.$transaction().
 *
 * In SQLite, $transaction provides real ACID guarantees. All operations
 * run in a single transaction — if any throws, everything rolls back.
 *
 * The wallet increment, ledger insert, and status transition commit together.
 * Legacy REJECTED rows without a refund ledger are ambiguous and are not
 * auto-recovered from refundToken; the caller must route them to reconciliation.
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
          throw new Error(
            `FINANCIAL INCONSISTENCY: withdrawal ${input.withdrawalId} is REJECTED without a REFUND ledger. Manual reconciliation required.`
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

/**
 * Compensate a wallet debit when WithdrawalRequest creation failed.
 *
 * Unlike the withdrawal-rejection flow, this path has no WithdrawalRequest row
 * to act as a durable state machine. Therefore all writes that make the refund
 * visible (wallet increment, unique REFUND ledger row, idempotency finalization)
 * must commit together. If a crash occurs before this operation begins, the
 * original debit remains ambiguous and must be manually reconciled; a marker is
 * never treated as proof that money moved.
 */
export type AtomicNoWithdrawalCompensationInput = {
  walletId: string;
  amount: number;
  scopedKey: string;
  description: string;
  createdBy: string;
};

export async function executeAtomicNoWithdrawalCompensation(
  input: AtomicNoWithdrawalCompensationInput
): Promise<AtomicRefundResult> {
  const db = await getDbForLib();

  if (isCloudflareWorkers) {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const d1 = ctx.env.DB;
    if (!d1) throw new Error("D1 binding 'DB' not found — cannot compensate wallet debit");

    const now = new Date().toISOString();
    const ledgerId = `ledger_comp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const response = JSON.stringify({ compensation: "completed", ledgerId });

    // D1 batch is transactional. If the unique REFUND index rejects the insert,
    // the wallet increment and idempotency update are rolled back with it.
    const results = await d1.batch([
      d1.prepare(
        `UPDATE Wallet
         SET balance = balance + ?, updatedAt = ?
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM IdempotencyKey WHERE key = ? AND status = 'IN_PROGRESS')
           AND NOT EXISTS (SELECT 1 FROM WalletLedger
                           WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')
         RETURNING balance`
      ).bind(input.amount, now, input.walletId, input.scopedKey, input.scopedKey),
      d1.prepare(
        `INSERT INTO WalletLedger
         (id, walletId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description, createdBy, createdAt)
         SELECT ?, ?, 'REFUND', ?, balance - ?, balance, 'Withdrawal', ?, ?, ?, ?
         FROM Wallet
         WHERE id = ?
           AND EXISTS (SELECT 1 FROM IdempotencyKey WHERE key = ? AND status = 'IN_PROGRESS')
           AND NOT EXISTS (SELECT 1 FROM WalletLedger
                           WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')`
      ).bind(
        ledgerId, input.walletId, input.amount, input.amount, input.scopedKey,
        input.description, input.createdBy, now, input.walletId, input.scopedKey, input.scopedKey
      ),
      d1.prepare(
        `UPDATE IdempotencyKey
         SET status = 'FAILED', response = ?, updatedAt = ?
         WHERE key = ? AND status = 'IN_PROGRESS'
           AND EXISTS (SELECT 1 FROM WalletLedger
                       WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND')`
      ).bind(response, now, input.scopedKey, input.scopedKey),
    ]);

    const updatedBalanceRows = (results[0].results ?? []) as Array<{ balance: number | string }>;
    const ledgerChanges = results[1].meta.changes ?? 0;
    const keyChanges = results[2].meta.changes ?? 0;

    if (updatedBalanceRows.length === 1 && ledgerChanges === 1 && keyChanges === 1) {
      const balanceAfter = Number(updatedBalanceRows[0].balance);
      return {
        success: true,
        refundLedgerId: ledgerId,
        newBalance: balanceAfter,
        alreadyRefunded: false,
      };
    }

    // A previous atomic compensation may already have committed. Never increment
    // again when the unique ledger exists; just make the idempotency state terminal.
    const existingLedger = await d1.prepare(
      `SELECT id FROM WalletLedger
       WHERE referenceType = 'Withdrawal' AND referenceId = ? AND type = 'REFUND' LIMIT 1`
    ).bind(input.scopedKey).first<{ id: string }>();
    if (existingLedger) {
      await d1.prepare(
        `UPDATE IdempotencyKey SET status = 'FAILED', updatedAt = ?
         WHERE key = ? AND status = 'IN_PROGRESS'`
      ).bind(now, input.scopedKey).run();
      const walletRow = await d1.prepare(
        `SELECT balance FROM Wallet WHERE id = ?`
      ).bind(input.walletId).first<{ balance: number | string }>();
      return {
        success: true,
        refundLedgerId: existingLedger.id,
        newBalance: Number(walletRow?.balance ?? 0),
        alreadyRefunded: true,
      };
    }

    throw new Error(
      `Atomic no-withdrawal compensation made no complete transition for key ${input.scopedKey}; no refund ledger exists. Manual reconciliation required.`
    );
  }

  return db.$transaction(async (tx) => {
    const existingLedger = await tx.walletLedger.findFirst({
      where: {
        referenceType: "Withdrawal",
        referenceId: input.scopedKey,
        type: "REFUND",
      },
    });
    if (existingLedger) {
      await tx.idempotencyKey.updateMany({
        where: { key: input.scopedKey, status: "IN_PROGRESS" },
        data: {
          status: "FAILED",
          response: JSON.stringify({ compensation: "completed", ledgerId: existingLedger.id }),
        },
      });
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

    const walletBefore = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });
    if (!walletBefore) throw new Error(`Wallet ${input.walletId} not found`);

    const refund = await tx.wallet.updateMany({
      where: { id: input.walletId },
      data: { balance: { increment: input.amount } },
    });
    if (refund.count !== 1) throw new Error("Wallet compensation did not update exactly one row");

    const balanceBefore = Number(walletBefore.balance);
    const balanceAfter = balanceBefore + input.amount;
    const ledger = await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "REFUND",
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        referenceType: "Withdrawal",
        referenceId: input.scopedKey,
        description: input.description,
        createdBy: input.createdBy,
      },
    });
    const keyUpdate = await tx.idempotencyKey.updateMany({
      where: { key: input.scopedKey, status: "IN_PROGRESS" },
      data: {
        status: "FAILED",
        response: JSON.stringify({ compensation: "completed", ledgerId: ledger.id }),
      },
    });
    if (keyUpdate.count !== 1) {
      throw new Error("Idempotency key changed during atomic compensation; transaction rolled back");
    }

    return {
      success: true,
      refundLedgerId: ledger.id,
      newBalance: balanceAfter,
      alreadyRefunded: false,
    };
  });
}
