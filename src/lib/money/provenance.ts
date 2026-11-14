import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

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
 * Every persisted part must independently attest its IRR unit. A deployment
 * flag cannot upgrade legacy rows or substitute for the row's own evidence.
 */
export function areJobPartPriceSourcesVerified(parts: readonly unknown[]): boolean {
  return parts.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const part = value as Record<string, unknown>;
    if (part.financialUnitStatus !== "VERIFIED_IRR" ||
        part.unitPrice === null || part.unitPrice === undefined ||
        !isSafeStoredIrrAmount(part.unitPrice)) return false;
    const unitPrice = Number(part.unitPrice);
    const quantity = part.quantity;
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 ||
        typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) return false;
    return BigInt(unitPrice) * BigInt(quantity) <= BigInt(Number.MAX_SAFE_INTEGER);
  });
}
