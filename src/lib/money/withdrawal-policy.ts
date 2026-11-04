export type IrrWithdrawalPolicy = {
  minIrr: number;
  maxIrr: number;
};

/**
 * Production withdrawals stay disabled until the owner-approved limits are
 * explicitly configured as integer IRR. No USD conversion or default limit.
 */
export function getApprovedIrrWithdrawalPolicy(
  env: Record<string, string | undefined> = process.env,
): IrrWithdrawalPolicy | null {
  if (env.NODE_ENV !== "production") return null;
  if (env.MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED !== "true") return null;

  const minIrr = Number(env.MEKANIX_WITHDRAWAL_MIN_IRR);
  const maxIrr = Number(env.MEKANIX_WITHDRAWAL_MAX_IRR);

  if (
    !Number.isSafeInteger(minIrr) ||
    !Number.isSafeInteger(maxIrr) ||
    minIrr <= 0 ||
    maxIrr < minIrr
  ) {
    return null;
  }

  return { minIrr, maxIrr };
}

export function isValidIrrWithdrawalAmount(
  amount: unknown,
  policy: IrrWithdrawalPolicy,
): amount is number {
  return typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount >= policy.minIrr &&
    amount <= policy.maxIrr;
}


export type WithdrawalRecordIrrError =
  | "WITHDRAWAL_IRR_PROVENANCE_UNVERIFIED"
  | "WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR";

/**
 * Protect admin transitions for historical withdrawal rows. The database
 * does not persist a currency/provenance field on WithdrawalRequest, so
 * production must require an explicit owner attestation that all existing
 * withdrawal amounts were reconciled to IRR before approval, refund or payout.
 */
export function getWithdrawalRecordIrrError(
  amount: unknown,
  env: Record<string, string | undefined> = process.env,
): WithdrawalRecordIrrError | null {
  if (env.NODE_ENV !== "production") return null;

  if (env.MEKANIX_WITHDRAWAL_IRR_PROVENANCE_VERIFIED !== "true") {
    return "WITHDRAWAL_IRR_PROVENANCE_UNVERIFIED";
  }

  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    return "WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR";
  }

  return null;
}
