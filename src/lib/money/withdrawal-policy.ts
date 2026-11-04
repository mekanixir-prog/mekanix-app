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
