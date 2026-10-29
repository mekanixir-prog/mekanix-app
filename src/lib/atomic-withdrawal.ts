import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

export type AtomicWithdrawalInput = {
  walletId: string;
  idempotencyKey: string;
  amount: number;
  method: string;
  cardNumber?: string | null;
  bankName?: string | null;
  shebaNumber?: string | null;
  userId: string;
  correlationId: string;
};

export type AtomicWithdrawalResult = {
  withdrawal: {
    id: string;
    code: string;
    walletId: string;
    amount: number;
    method: string;
    cardNumber: string | null;
    bankName: string | null;
    shebaNumber: string | null;
    status: "REQUESTED";
    requestedAt: string | Date;
    processedAt: null;
    adminNotes: null;
    reviewerId: null;
    txnId: null;
  };
  newBalance: number;
};

export class InsufficientWithdrawalBalanceError extends Error {
  constructor() {
    super("موجودی کافی نیست یا هم‌زمان تغییر کرده است");
    this.name = "InsufficientWithdrawalBalanceError";
  }
}

/**
 * Records the debit, withdrawal request, ledger row and idempotency response
 * as one database unit. D1 uses a single transactional batch; local SQLite
 * uses Prisma $transaction. Never compensate by issuing a second, unrelated
 * wallet increment when the original atomic unit failed.
 */
export async function executeAtomicWithdrawal(
  db: PrismaClient,
  input: AtomicWithdrawalInput
): Promise<AtomicWithdrawalResult> {
  const isWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

  if (isWorkers) return executeD1Withdrawal(input);

  return db.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!wallet || Number(wallet.balance) < input.amount) {
      throw new InsufficientWithdrawalBalanceError();
    }

    const balanceBefore = Number(wallet.balance);
    const debit = await tx.wallet.updateMany({
      where: { id: input.walletId, balance: { gte: input.amount } },
      data: { balance: { decrement: input.amount } },
    });
    if (debit.count !== 1) throw new InsufficientWithdrawalBalanceError();

    const updatedWallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!updatedWallet) throw new Error("Wallet disappeared during atomic withdrawal");
    const newBalance = Number(updatedWallet.balance);
    const now = new Date();
    const withdrawal = await tx.withdrawalRequest.create({
      data: {
        code: createWithdrawalCode(),
        walletId: input.walletId,
        amount: input.amount,
        method: input.method,
        cardNumber: input.cardNumber ?? undefined,
        bankName: input.bankName ?? undefined,
        shebaNumber: input.shebaNumber ?? undefined,
        status: "REQUESTED",
        requestedAt: now,
      },
    });

    await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "WITHDRAWAL",
        amount: -input.amount,
        balanceBefore,
        balanceAfter: newBalance,
        referenceType: "Withdrawal",
        referenceId: withdrawal.id,
        description: `Withdrawal request ${withdrawal.code}`,
        createdBy: input.userId,
        createdAt: now,
      },
    });

    const response: AtomicWithdrawalResult = {
      withdrawal: {
        id: withdrawal.id,
        code: withdrawal.code,
        walletId: withdrawal.walletId,
        amount: Number(withdrawal.amount),
        method: withdrawal.method,
        cardNumber: withdrawal.cardNumber,
        bankName: withdrawal.bankName,
        shebaNumber: withdrawal.shebaNumber,
        status: "REQUESTED",
        requestedAt: withdrawal.requestedAt,
        processedAt: null,
        adminNotes: null,
        reviewerId: null,
        txnId: null,
      },
      newBalance,
    };
    const finalized = await tx.idempotencyKey.updateMany({
      where: { key: input.idempotencyKey, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", response: JSON.stringify(response) },
    });
    if (finalized.count !== 1) {
      throw new Error("Idempotency key could not be finalized inside withdrawal transaction");
    }
    return response;
  });
}

function createWithdrawalCode(): string {
  return `WD-${Math.floor(100000 + Math.random() * 900000)}`;
}

async function executeD1Withdrawal(input: AtomicWithdrawalInput): Promise<AtomicWithdrawalResult> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const ctx = await getCloudflareContext({ async: true });
  const d1 = (ctx.env as { DB?: D1Database }).DB;
  if (!d1) throw new Error("Cloudflare D1 binding DB is unavailable");

  // Every attempt is a single D1 batch. D1 batch statements execute
  // transactionally, so a failure rolls back debit, request, ledger and
  // idempotency finalization together.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const now = new Date().toISOString();
    const withdrawalId = randomUUID();
    const ledgerId = randomUUID();
    const code = createWithdrawalCode();
    const description = `Withdrawal request ${code}`;

    try {
      const results = await d1.batch([
        d1.prepare(`UPDATE "Wallet"
          SET "balance" = "balance" - ?, "updatedAt" = ?
          WHERE "id" = ? AND "balance" >= ?
            AND EXISTS (SELECT 1 FROM "IdempotencyKey" WHERE "key" = ? AND "status" = 'IN_PROGRESS')`)
          .bind(input.amount, now, input.walletId, input.amount, input.idempotencyKey),
        d1.prepare(`INSERT INTO "WithdrawalRequest"
          ("id","code","walletId","amount","method","cardNumber","bankName","shebaNumber","status","requestedAt")
          SELECT ?,?,?,?,?,?,?,?,'REQUESTED',?
          WHERE changes() = 1`)
          .bind(withdrawalId, code, input.walletId, input.amount, input.method,
            input.cardNumber ?? null, input.bankName ?? null, input.shebaNumber ?? null, now),
        d1.prepare(`INSERT INTO "WalletLedger"
          ("id","walletId","type","amount","balanceBefore","balanceAfter","referenceType","referenceId","description","createdBy","createdAt")
          SELECT ?, w."id", 'WITHDRAWAL', -?, w."balance" + ?, w."balance",
            'Withdrawal', wr."id", ?, ?, ?
          FROM "Wallet" w JOIN "WithdrawalRequest" wr
            ON wr."id" = ? AND wr."walletId" = w."id"
          WHERE w."id" = ?`)
          .bind(ledgerId, input.amount, input.amount, description, input.userId, now, withdrawalId, input.walletId),
        d1.prepare(`UPDATE "IdempotencyKey"
          SET "status" = 'COMPLETED',
              "response" = (
                SELECT json_object(
                  'withdrawal', json_object(
                    'id', wr."id", 'code', wr."code", 'walletId', wr."walletId",
                    'amount', wr."amount", 'method', wr."method",
                    'cardNumber', wr."cardNumber", 'bankName', wr."bankName",
                    'shebaNumber', wr."shebaNumber", 'status', wr."status",
                    'requestedAt', wr."requestedAt", 'processedAt', wr."processedAt",
                    'adminNotes', wr."adminNotes", 'reviewerId', wr."reviewerId", 'txnId', wr."txnId"
                  ),
                  'newBalance', w."balance"
                )
                FROM "WithdrawalRequest" wr
                JOIN "Wallet" w ON w."id" = wr."walletId"
                JOIN "WalletLedger" l ON l."referenceType" = 'Withdrawal'
                  AND l."referenceId" = wr."id" AND l."type" = 'WITHDRAWAL'
                WHERE wr."id" = ?
              ),
              "updatedAt" = ?
          WHERE "key" = ? AND "status" = 'IN_PROGRESS'
            AND EXISTS (SELECT 1 FROM "WalletLedger" WHERE "id" = ?)`)
          .bind(withdrawalId, now, input.idempotencyKey, ledgerId),
        d1.prepare(`SELECT "response" FROM "IdempotencyKey"
          WHERE "key" = ? AND "status" = 'COMPLETED'`)
          .bind(input.idempotencyKey),
        d1.prepare(`SELECT changes() AS changes`),
      ]);

      const debitChanges = Number(results[0]?.meta?.changes ?? 0);
      if (debitChanges !== 1) throw new InsufficientWithdrawalBalanceError();

      const rows = (results[4] as D1Result<{ response: string }>).results;
      const serialized = rows?.[0]?.response;
      if (!serialized) throw new Error("Atomic withdrawal batch did not finalize its idempotency response");
      return JSON.parse(serialized) as AtomicWithdrawalResult;
    } catch (error) {
      if (error instanceof InsufficientWithdrawalBalanceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const uniqueCodeCollision =
        message.includes("WithdrawalRequest.code") || message.includes("UNIQUE constraint failed");
      if (uniqueCodeCollision && attempt < 3) continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique withdrawal code");
}
