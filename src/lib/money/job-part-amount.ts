import { assertIrrInteger } from "@/lib/money/irr";

export type JobPartAmountError =
  | "PART_QUANTITY_MUST_BE_POSITIVE_INTEGER"
  | "PART_UNIT_PRICE_MUST_BE_NON_NEGATIVE_INTEGER_IRR"
  | "PART_LINE_TOTAL_EXCEEDS_SAFE_INTEGER_IRR";

/** Validate the API contract without coercion, flooring, implicit defaults, or currency conversion. */
export function getJobPartAmountError(
  quantity: unknown,
  unitPrice: unknown,
): JobPartAmountError | null {
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return "PART_QUANTITY_MUST_BE_POSITIVE_INTEGER";
  }

  try {
    assertIrrInteger(unitPrice, "Job part unit price");
  } catch {
    return "PART_UNIT_PRICE_MUST_BE_NON_NEGATIVE_INTEGER_IRR";
  }

  // A safe unit price and safe quantity can still multiply to an unsafe
  // monetary line total. Use BigInt so the check itself cannot overflow.
  if (BigInt(quantity) * BigInt(unitPrice as number) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return "PART_LINE_TOTAL_EXCEEDS_SAFE_INTEGER_IRR";
  }

  return null;
}
