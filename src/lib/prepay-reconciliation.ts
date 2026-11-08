import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

type AmountRecord = Record<string, unknown>;

type PrepayJob = AmountRecord & {
  id: string;
  prepayPaid: boolean;
  financialUnitStatus: unknown;
  inspectionFee: unknown;
  travelFee: unknown;
  platformCommission: unknown;
  netEarnings: unknown;
};

type PrepayWallet = AmountRecord & {
  id: string;
  financialUnitStatus: unknown;
  balance: unknown;
  pendingBalance: unknown;
  totalEarned: unknown;
  totalCommission: unknown;
  totalWithdrawn: unknown;
};

function sameAmount(value: unknown, expected: number): boolean {
  return isSafeStoredIrrAmount(value) && Number(value) === expected;
}

/**
 * A paid marker plus four rows is not sufficient evidence of a committed
 * prepayment. Validate the complete row linkage, per-row IRR attestations,
 * amounts, transaction kinds/statuses, and ledger arithmetic before a retry
 * or reconciliation endpoint reports COMMITTED.
 */
export function isCommittedPrepayConsistent(
  job: PrepayJob,
  wallet: PrepayWallet | null,
  prepayTransaction: AmountRecord | null,
  commissionTransaction: AmountRecord | null,
  holdLedger: AmountRecord | null,
  commissionLedger: AmountRecord | null,
): boolean {
  if (
    !job.prepayPaid ||
    job.financialUnitStatus !== "VERIFIED_IRR" ||
    !wallet ||
    wallet.financialUnitStatus !== "VERIFIED_IRR" ||
    ![wallet.balance, wallet.pendingBalance, wallet.totalEarned, wallet.totalCommission, wallet.totalWithdrawn]
      .every(isSafeStoredIrrAmount) ||
    !prepayTransaction ||
    !commissionTransaction ||
    !holdLedger ||
    !commissionLedger
  ) return false;

  const amounts = [job.inspectionFee, job.travelFee, job.platformCommission, job.netEarnings];
  if (!amounts.every(isSafeStoredIrrAmount)) return false;
  const [inspectionFee, travelFee, commission, net] = amounts.map(Number);
  const gross = inspectionFee + travelFee;
  if (
    ![inspectionFee, travelFee, commission, net, gross].every(Number.isSafeInteger) ||
    inspectionFee < 0 || travelFee < 0 || commission < 0 || net < 0 ||
    gross <= 0 || gross !== commission + net
  ) return false;

  const verified = (row: AmountRecord) => row.financialUnitStatus === "VERIFIED_IRR";
  const linked = (row: AmountRecord) => row.walletId === wallet.id;
  const prepayStatus = prepayTransaction.status === "PENDING" || prepayTransaction.status === "AVAILABLE";
  if (
    !verified(prepayTransaction) || !linked(prepayTransaction) ||
    prepayTransaction.jobId !== job.id || prepayTransaction.kind !== "PREPAY" ||
    !prepayStatus ||
    !sameAmount(prepayTransaction.grossAmount, gross) ||
    !sameAmount(prepayTransaction.commissionAmount, commission) ||
    !sameAmount(prepayTransaction.netAmount, net)
  ) return false;

  if (
    !verified(commissionTransaction) || !linked(commissionTransaction) ||
    commissionTransaction.jobId !== job.id || commissionTransaction.kind !== "COMMISSION" ||
    commissionTransaction.status !== "COMPLETED" ||
    !sameAmount(commissionTransaction.grossAmount, 0) ||
    !sameAmount(commissionTransaction.commissionAmount, commission) ||
    !sameAmount(commissionTransaction.netAmount, -commission)
  ) return false;

  const holdBefore = holdLedger.balanceBefore;
  const holdAfter = holdLedger.balanceAfter;
  if (
    !verified(holdLedger) || !linked(holdLedger) ||
    holdLedger.type !== "HOLD" || holdLedger.referenceType !== "Job" ||
    holdLedger.referenceId !== job.id || !sameAmount(holdLedger.amount, net) ||
    !isSafeStoredIrrAmount(holdBefore) || !isSafeStoredIrrAmount(holdAfter) ||
    Number(holdAfter) !== Number(holdBefore) + net
  ) return false;

  const commissionBefore = commissionLedger.balanceBefore;
  const commissionAfter = commissionLedger.balanceAfter;
  return verified(commissionLedger) &&
    linked(commissionLedger) &&
    commissionLedger.type === "COMMISSION" &&
    commissionLedger.referenceType === "Job" &&
    commissionLedger.referenceId === job.id &&
    sameAmount(commissionLedger.amount, -commission) &&
    isSafeStoredIrrAmount(commissionBefore) &&
    isSafeStoredIrrAmount(commissionAfter) &&
    Number(commissionBefore) === Number(commissionAfter);
}
