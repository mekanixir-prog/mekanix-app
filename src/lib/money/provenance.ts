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

/**
 * Parse a persisted IRR amount without accepting fractional, unsafe, or
 * negative values. Prisma Decimal instances are supported via toString().
 */
export function toSafeIntegerIrr(value: unknown, allowNegative = false): number | null {
  let raw: string;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && (allowNegative || value >= 0) ? value : null;
  }
  if (typeof value === "string") {
    raw = value.trim();
  } else if (typeof value === "bigint") {
    raw = value.toString();
  } else if (typeof value === "object" && value !== null && "toString" in value) {
    raw = String(value);
  } else {
    return null;
  }

  const integerPattern = allowNegative ? /^-?\d+(?:\.0+)?$/ : /^\\+?\d+(?:\.0+)?$/;
  if (!integerPattern.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && (allowNegative || parsed >= 0) ? parsed : null;
}


/** Commercial pricing policy is a release gate, not row-level provenance. */
export function isInvoicePricingPolicyApproved(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV !== "production" || env.MEKANIX_PRICING_IRR_APPROVED === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Technician fee sources must carry their own verified IRR attestation. */
export function areTechnicianPriceSourcesVerified(technician: unknown): boolean {
  if (!isRecord(technician) || technician.financialUnitStatus !== "VERIFIED_IRR") return false;
  return ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"].every(
    (field) => toSafeIntegerIrr(technician[field]) !== null,
  );
}
