/**
 * A writer may attest a source row only when its own record-level status is
 * VERIFIED_IRR and every monetary source is an exact, non-negative safe
 * integer. Environment flags are not provenance evidence.
 */
function toSafeIntegerIrr(value: unknown): number | null {
  let raw: string;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

  // Prisma Decimal may stringify an integral value with a zero-only fraction.
  if (!/^\+?\d+(?:\.0+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Technician fees are usable only when the technician row attests to IRR. */
export function areInvoicePriceSourcesVerified(technician: unknown): boolean {
  if (!isRecord(technician) || technician.financialUnitStatus !== "VERIFIED_IRR") return false;
  return ["hourlyRate", "travelFeeBase"].every((field) =>
    toSafeIntegerIrr(technician[field]) !== null
  );
}

/**
 * Every persisted part is checked independently. A deployment flag cannot
 * upgrade legacy rows, and a verified parent Job cannot attest its Parts.
 */
export function areJobPartPriceSourcesVerified(parts: readonly unknown[]): boolean {
  return parts.every((part) => {
    if (!isRecord(part) || part.financialUnitStatus !== "VERIFIED_IRR") return false;
    const unitPrice = toSafeIntegerIrr(part.unitPrice);
    const quantity = part.quantity;
    if (unitPrice === null || typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) || quantity <= 0) return false;
    return BigInt(unitPrice) * BigInt(quantity) <= BigInt(Number.MAX_SAFE_INTEGER);
  });
}
