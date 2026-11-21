export type FinancialUnitStatus = "UNVERIFIED" | "VERIFIED_IRR" | "QUARANTINED";

/**
 * A record-level attestation is the only authority for exposing a stored
 * monetary value as canonical IRR. Currency metadata alone is not provenance.
 * If a record has an explicit currency column, it must also say IRR.
 */
export function isVerifiedIrrRecord(
  status: unknown,
  currency?: unknown,
): status is "VERIFIED_IRR" {
  return status === "VERIFIED_IRR" && (currency === undefined || currency === "IRR");
}
