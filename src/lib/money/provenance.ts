/**
 * Production invoice creation must not infer the unit of legacy price sources.
 * Development/test data remains usable; production requires explicit evidence
 * for the approved IRR rate card and technician fee units.
 */
export function areInvoicePriceSourcesVerified(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV !== "production" || (
    env.MEKANIX_PRICING_IRR_APPROVED === "true" &&
    env.MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED === "true"
  );
}

/**
 * JobPart predates the IRR-only writer and has no trustworthy currency field.
 * Only require its provenance attestation when an invoice contains parts.
 */
export function areJobPartPriceSourcesVerified(
  hasParts: boolean,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !hasParts || env.NODE_ENV !== "production" ||
    env.MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED === "true";
}
