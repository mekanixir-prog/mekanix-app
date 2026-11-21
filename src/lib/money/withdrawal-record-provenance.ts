export type WithdrawalRecordIrrError =
  | "WITHDRAWAL_IRR_PROVENANCE_UNVERIFIED"
  | "WITHDRAWAL_AMOUNT_NOT_INTEGER_IRR";

/**
 * Production admin transitions must not move historical money whose unit is
 * unknown. WithdrawalRequest has no currency column, so an explicit owner
 * attestation is required after reconciling every existing row to integer IRR.
 * This function never converts or infers a legacy amount.
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
