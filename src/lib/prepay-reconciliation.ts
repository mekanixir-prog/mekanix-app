import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

type MoneyValue = unknown;

type PrepayJobSnapshot = {
  id: string;
  prepayPaid: boolean;
  prepayPaidAt: unknown;
  inspectionFee: MoneyValue;
  travelFee: MoneyValue;
  platformCommission: MoneyValue;
  netEarnings: MoneyValue;
  financialUnitStatus: unknown;
};

type WalletTransactionSnapshot = {
  walletId: unknown;
  jobId: unknown;
  kind: unknown;
  status: unknown;
  grossAmount: MoneyValue;
  commissionAmount: MoneyValue;
  netAmount: MoneyValue;
  idempotencyKey: unknown;
  financialUnitStatus: unknown;
};

type WalletLedgerSnapshot = {
  walletId: unknown;
  type: unknown;
  amount: MoneyValue;
  balanceBefore: MoneyValue;
  balanceAfter: MoneyValue;
  referenceType: unknown;
  referenceId: unknown;
  idempotencyKey: unknown;
  financialUnitStatus: unknown;
};

export type PrepayRecordSet = {
  job: PrepayJobSnapshot;
  prepayTransaction: WalletTransactionSnapshot | null;
  commissionTransaction: WalletTransactionSnapshot | null;
  holdLedger: WalletLedgerSnapshot | null;
  commissionLedger: WalletLedgerSnapshot | null;
};

export type PrepayReconciliationResult =
  | { ok: true }
  | { ok: false; reason: string };

function toSafeBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined || !isSafeStoredIrrAmount(value)) return null;
  try {
    const raw = typeof value === "object" && value !== null
      ? value.toString()
      : String(value);
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Confirms that the paid marker, job amounts, two wallet transactions and two
 * ledger rows describe the same verified-IRR prepay. Existence-only checks are
 * insufficient for a financial COMMITTED response.
 */
export function validatePrepayRecordSet(input: PrepayRecordSet): PrepayReconciliationResult {
  const { job, prepayTransaction, commissionTransaction, holdLedger, commissionLedger } = input;
  if (!job.prepayPaid || !job.prepayPaidAt) return { ok: false, reason: "JOB_PAID_MARKER_MISSING" };
  if (job.financialUnitStatus !== "VERIFIED_IRR") return { ok: false, reason: "JOB_FINANCIAL_PROVENANCE_UNVERIFIED" };
  if (!prepayTransaction || !commissionTransaction || !holdLedger || !commissionLedger) {
    return { ok: false, reason: "FINANCIAL_RECORD_MISSING" };
  }

  const inspection = toSafeBigInt(job.inspectionFee);
  const travel = toSafeBigInt(job.travelFee);
  const commission = toSafeBigInt(job.platformCommission);
  const net = toSafeBigInt(job.netEarnings);
  if ([inspection, travel, commission, net].some((value) => value === null)) {
    return { ok: false, reason: "JOB_AMOUNT_UNSAFE_OR_MISSING" };
  }
  if (inspection! < 0n || travel! < 0n || commission! < 0n || net! < 0n) {
    return { ok: false, reason: "JOB_AMOUNT_NEGATIVE" };
  }
  const gross = inspection! + travel!;
  if (gross <= 0n || gross !== commission! + net!) {
    return { ok: false, reason: "JOB_AMOUNT_TOTAL_MISMATCH" };
  }

  const walletId = prepayTransaction.walletId;
  if (typeof walletId !== "string" || !walletId ||
      commissionTransaction.walletId !== walletId ||
      holdLedger.walletId !== walletId ||
      commissionLedger.walletId !== walletId) {
    return { ok: false, reason: "WALLET_REFERENCE_MISMATCH" };
  }

  const verifiedRows = [
    prepayTransaction.financialUnitStatus,
    commissionTransaction.financialUnitStatus,
    holdLedger.financialUnitStatus,
    commissionLedger.financialUnitStatus,
  ];
  if (verifiedRows.some((status) => status !== "VERIFIED_IRR")) {
    return { ok: false, reason: "LEDGER_FINANCIAL_PROVENANCE_UNVERIFIED" };
  }

  if (
    prepayTransaction.jobId !== job.id ||
    prepayTransaction.kind !== "PREPAY" ||
    prepayTransaction.status !== "PENDING" ||
    prepayTransaction.idempotencyKey !== `prepay:${job.id}:PREPAY` ||
    toSafeBigInt(prepayTransaction.grossAmount) !== gross ||
    toSafeBigInt(prepayTransaction.commissionAmount) !== commission ||
    toSafeBigInt(prepayTransaction.netAmount) !== net
  ) {
    return { ok: false, reason: "PREPAY_TRANSACTION_MISMATCH" };
  }

  if (
    commissionTransaction.jobId !== job.id ||
    commissionTransaction.kind !== "COMMISSION" ||
    commissionTransaction.status !== "COMPLETED" ||
    commissionTransaction.idempotencyKey !== `prepay:${job.id}:COMMISSION` ||
    toSafeBigInt(commissionTransaction.grossAmount) !== 0n ||
    toSafeBigInt(commissionTransaction.commissionAmount) !== commission ||
    toSafeBigInt(commissionTransaction.netAmount) !== -commission
  ) {
    return { ok: false, reason: "COMMISSION_TRANSACTION_MISMATCH" };
  }

  const holdAmount = toSafeBigInt(holdLedger.amount);
  const holdBefore = toSafeBigInt(holdLedger.balanceBefore);
  const holdAfter = toSafeBigInt(holdLedger.balanceAfter);
  if (
    holdLedger.type !== "HOLD" ||
    holdLedger.referenceType !== "Job" ||
    holdLedger.referenceId !== job.id ||
    holdLedger.idempotencyKey !== `prepay:${job.id}:LEDGER_HOLD` ||
    holdAmount !== net ||
    holdBefore === null ||
    holdAfter === null ||
    holdBefore + net !== holdAfter
  ) {
    return { ok: false, reason: "HOLD_LEDGER_MISMATCH" };
  }

  const commissionAmount = toSafeBigInt(commissionLedger.amount);
  const commissionBefore = toSafeBigInt(commissionLedger.balanceBefore);
  const commissionAfter = toSafeBigInt(commissionLedger.balanceAfter);
  if (
    commissionLedger.type !== "COMMISSION" ||
    commissionLedger.referenceType !== "Job" ||
    commissionLedger.referenceId !== job.id ||
    commissionLedger.idempotencyKey !== `prepay:${job.id}:LEDGER_COMMISSION` ||
    commissionAmount !== -commission ||
    commissionBefore !== holdAfter ||
    commissionAfter !== holdAfter
  ) {
    return { ok: false, reason: "COMMISSION_LEDGER_MISMATCH" };
  }

  return { ok: true };
}
