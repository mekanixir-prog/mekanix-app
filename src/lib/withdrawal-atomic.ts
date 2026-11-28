import type { PrismaClient } from "@prisma/client";
import { isSafeNonNegativeStoredIrrAmount } from "@/lib/money/financial-read-mask";

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
  input: WithdrawalInput,
): Promise<boolean> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return false;
  return db.$transaction(async (tx) => {
    const existing = await tx.withdrawalRequest.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) return false;
    const walletBefore = await tx.wallet.findUnique({ where: { id: input.walletId }, select: { balance: true, financialUnitStatus: true } });
    if (!walletBefore || walletBefore.financialUnitStatus !== "VERIFIED_IRR" || !isSafeNonNegativeStoredIrrAmount(walletBefore.balance)) return false;

    const debit = await tx.wallet.updateMany({
      where: { id: input.walletId, financialUnitStatus: "VERIFIED_IRR", balance: { gte: input.amount } },
      data: { balance: { decrement: input.amount } },
    });
    if (debit.count !== 1) return false;

    const wallet = await tx.wallet.findUnique({
      where: { id: input.walletId },
      select: { balance: true, financialUnitStatus: true },
    });
    if (!wallet || wallet.financialUnitStatus !== "VERIFIED_IRR" || !isSafeNonNegativeStoredIrrAmount(wallet.balance)) throw new Error("Wallet financial provenance is not verified");

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
        financialUnitStatus: "VERIFIED_IRR",
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
        financialUnitStatus: "VERIFIED_IRR",
      },
    });
    return true;
  });
}

/**
 * D1 batch is transactional, but a zero-row conditional write is not an SQL
 * error. The SELECT guards force the whole batch to abort unless each
 * compare-and-set mutation changes exactly one row.
 */
export async function createWithdrawalWithD1(
  d1: D1Database,
  input: WithdrawalInput,
): Promise<boolean> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) return false;
  const at = input.requestedAt.toISOString();
  const ledgerKey = `withdrawal:${input.idempotencyKey}:LEDGER`;
  const assertOneChange = () =>
    d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();

  const statements = [
    d1.prepare(`
      INSERT INTO "WithdrawalRequest"
        ("id", "code", "walletId", "amount", "method", "cardNumber",
         "bankName", "shebaNumber", "status", "idempotencyKey", "requestedAt", "financialUnitStatus")
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, 'VERIFIED_IRR'
      FROM "Wallet"
      WHERE "id" = ? AND "financialUnitStatus" = 'VERIFIED_IRR'
        AND "balance" = CAST("balance" AS INTEGER) AND abs("balance") <= 9007199254740991 AND "balance" >= ?
      ON CONFLICT("idempotencyKey") DO NOTHING
    `).bind(
      crypto.randomUUID(), input.code, input.walletId, input.amount,
      input.method, input.cardNumber, input.bankName, input.shebaNumber,
      input.idempotencyKey, at, input.walletId, input.amount,
    ),
    assertOneChange(),
    d1.prepare(`
      UPDATE "Wallet"
      SET "balance" = "balance" - ?, "updatedAt" = ?
      WHERE "id" = ? AND "financialUnitStatus" = 'VERIFIED_IRR'
        AND "balance" = CAST("balance" AS INTEGER) AND abs("balance") <= 9007199254740991 AND "balance" >= ? AND changes() = 1
    `).bind(input.amount, at, input.walletId, input.amount),
    assertOneChange(),
    d1.prepare(`
      INSERT INTO "WalletLedger"
        ("id", "walletId", "type", "amount", "balanceBefore", "balanceAfter",
         "referenceType", "referenceId", "description", "idempotencyKey", "createdAt", "financialUnitStatus")
      SELECT ?, w."id", 'WITHDRAWAL', ?, w."balance" + ?, w."balance",
             'Withdrawal', wr."id", ?, ?, ?, 'VERIFIED_IRR'
      FROM "Wallet" w
      JOIN "WithdrawalRequest" wr ON wr."idempotencyKey" = ?
      WHERE w."id" = ? AND wr."walletId" = w."id"
        AND wr."amount" = ? AND changes() = 1
    `).bind(
      crypto.randomUUID(), -input.amount, input.amount,
      `Withdrawal request ${input.code}`, ledgerKey, at,
      input.idempotencyKey, input.walletId, input.amount,
    ),
    assertOneChange(),
  ];

  try {
    const results = await d1.batch(statements);
    return [0, 2, 4].every((index) => (results[index]?.meta?.changes ?? 0) === 1);
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return false;
    throw error;
  }
}

export async function createWithdrawalAtomically(
  db: PrismaClient,
  input: WithdrawalInput,
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
