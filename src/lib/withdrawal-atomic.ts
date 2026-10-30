import type { PrismaClient } from "@prisma/client";

type WithdrawalInput = {
  walletId: string;
  idempotencyKey: string;
  amount: number;
  method: string;
  cardNumber: string | null;
  bankName: string | null;
  shebaNumber: string | null;
  code: string;
  requestedAt: Date;
};

type D1Result = { meta?: { changes?: number } };
type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = {
  prepare: (sql: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

/** Node/SQLite and PostgreSQL: debit, request and ledger commit or roll back together. */
export async function createWithdrawalWithPrisma(
  db: PrismaClient,
  input: WithdrawalInput
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const existing = await tx.withdrawalRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return false;

    const debit = await tx.wallet.updateMany({
      where: { id: input.walletId, balance: { gte: input.amount } },
      data: { balance: { decrement: input.amount } },
    });
    if (debit.count !== 1) return false;

    const wallet = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true },
    });
    if (!wallet) throw new Error("Wallet disappeared during withdrawal transaction");

    const balanceAfter = Number(wallet.balance);
    const balanceBefore = balanceAfter + input.amount;
    const withdrawal = await tx.withdrawalRequest.create({
      data: {
        code: input.code,
        walletId: input.walletId,
        amount: input.amount,
        method: input.method,
        cardNumber: input.cardNumber,
        bankName: input.bankName,
        shebaNumber: input.shebaNumber,
        status: "REQUESTED",
        idempotencyKey: input.idempotencyKey,
        requestedAt: input.requestedAt,
      },
    });
    await tx.walletLedger.create({
      data: {
        walletId: input.walletId,
        type: "WITHDRAWAL",
        amount: -input.amount,
        balanceBefore,
        balanceAfter,
        referenceType: "Withdrawal",
        referenceId: withdrawal.id,
        description: `Withdrawal request ${withdrawal.code}`,
        idempotencyKey: `withdrawal:${input.idempotencyKey}:LEDGER`,
      },
    });
    return true;
  });
}

/**
 * D1 batch is transactional. The request INSERT is the idempotency gate and
 * checks available balance. Only its winning insert permits the debit; only
 * the winning debit permits the ledger row. A retry or insufficient balance
 * produces zero changes and no partial financial state.
 */
export async function createWithdrawalWithD1(
  d1: D1Database,
  input: WithdrawalInput
): Promise<boolean> {
  const at = input.requestedAt.toISOString();
  const ledgerKey = `withdrawal:${input.idempotencyKey}:LEDGER`;
  const statements = [
    d1.prepare(`
      INSERT INTO "WithdrawalRequest"
        ("id", "code", "walletId", "amount", "method", "cardNumber",
         "bankName", "shebaNumber", "status", "idempotencyKey", "requestedAt")
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?
      FROM "Wallet"
      WHERE "id" = ? AND "balance" >= ?
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      crypto.randomUUID(), input.code, input.walletId, input.amount,
      input.method, input.cardNumber, input.bankName, input.shebaNumber,
      input.idempotencyKey, at, input.walletId, input.amount
    ),
    d1.prepare(`
      UPDATE "Wallet"
      SET "balance" = "balance" - ?, "updatedAt" = ?
      WHERE "id" = ? AND "balance" >= ? AND changes() = 1
    `).bind(input.amount, at, input.walletId, input.amount),
    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "createdAt")
      SELECT ?, w."id", 'WITHDRAWAL', ?, w."balance" + ?, w."balance",
             'Withdrawal', wr."id", ?, ?, ?
      FROM "Wallet" w
      JOIN "WithdrawalRequest" wr ON wr."idempotencyKey" = ?
      WHERE w."id" = ? AND wr."walletId" = w."id"
        AND wr."amount" = ? AND changes() = 1
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      crypto.randomUUID(), -input.amount, input.amount,
      `Withdrawal request ${input.code}`, ledgerKey, at,
      input.idempotencyKey, input.walletId, input.amount
    ),
  ];

  const results = await d1.batch(statements);
  const changes = results.map((result) => result.meta?.changes ?? 0);
  return changes[0] === 1 && changes[1] === 1 && changes[2] === 1;
}

export async function createWithdrawalAtomically(
  db: PrismaClient,
  input: WithdrawalInput
): Promise<boolean> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return createWithdrawalWithPrisma(db, input);

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  const d1 = (context.env as unknown as { DB?: D1Database }).DB;
  if (!d1) throw new Error("D1 binding 'DB' is unavailable for atomic withdrawal");
  return createWithdrawalWithD1(d1, input);
}
