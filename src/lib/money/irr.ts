import Decimal from "decimal.js";

/**
 * Canonical, policy-neutral money primitives for Iranian Rial (IRR).
 *
 * This module validates and calculates integer IRR values only. It does not
 * infer currencies, convert Toman, apply FX rates, or define business tariffs.
 * Owner approval of the IRR unit does not prove legacy-row provenance or
 * authorize using these helpers on an unclassified historical amount.
 */

export type IrrRoundingMode = "half-up" | "down" | "up";

export interface IrrValidationOptions {
  allowZero?: boolean;
}

const MAX_IRR = Number.MAX_SAFE_INTEGER;
// Safe-integer operands can produce up to 32 significant product digits.
// Keep ample guard precision so near-integer ratios round correctly.
const IrrDecimal = Decimal.clone({ precision: 80 });

export function assertIrrInteger(
  value: unknown,
  context = "IRR amount",
  options: IrrValidationOptions = {},
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${context} must be a safe integer number of IRR`);
  }

  if (value < 0) {
    throw new RangeError(`${context} cannot be negative`);
  }

  if (value === 0 && options.allowZero === false) {
    throw new RangeError(`${context} must be greater than zero`);
  }
}

/**
 * Parse the canonical API representation: a JSON number containing integer
 * IRR. Strings, Toman, decimals, and implicit coercions are intentionally not
 * accepted here.
 */
export function parseIrrInput(value: unknown, context = "IRR input"): number {
  assertIrrInteger(value, context);
  return value;
}

export function addIrr(...amounts: number[]): number {
  let total = 0;

  for (const amount of amounts) {
    assertIrrInteger(amount, "IRR addend");
    if (amount > MAX_IRR - total) {
      throw new RangeError("IRR addition exceeds Number.MAX_SAFE_INTEGER");
    }
    total += amount;
  }

  return total;
}

/**
 * Multiply an integer IRR amount by an explicit rational ratio. Callers must
 * choose a rounding mode; this helper deliberately has no business default.
 */
export function multiplyRatioIrr(
  amount: number,
  numerator: number,
  denominator: number,
  roundingMode: IrrRoundingMode,
): number {
  assertIrrInteger(amount, "IRR amount");
  assertIrrInteger(numerator, "Ratio numerator");
  assertIrrInteger(denominator, "Ratio denominator", { allowZero: false });

  const decimalRounding = {
    "half-up": Decimal.ROUND_HALF_UP,
    down: Decimal.ROUND_DOWN,
    up: Decimal.ROUND_UP,
  }[roundingMode];

  if (decimalRounding === undefined) {
    throw new TypeError("A supported IRR rounding mode must be selected");
  }

  const result = new IrrDecimal(amount)
    .mul(numerator)
    .div(denominator)
    .toDecimalPlaces(0, decimalRounding);

  if (!result.isInteger() || result.isNegative() || result.greaterThan(MAX_IRR)) {
    throw new RangeError("IRR ratio result is outside the safe integer range");
  }

  return result.toNumber();
}

/**
 * Convert an explicitly Toman-denominated legacy/API amount to canonical IRR.
 * This is a unit adapter, not an FX conversion: 1 Toman = 10 IRR.
 * quantity is used for unit-price × quantity before converting the total.
 */
export function tomanToIrr(amountToman: number, quantity = 1): number {
  assertIrrInteger(amountToman, "Toman amount");
  assertIrrInteger(quantity, "Toman quantity", { allowZero: false });
  const totalIrr = amountToman * quantity * 10;
  assertIrrInteger(totalIrr, "Converted IRR amount");
  return totalIrr;
}

/** Format an already validated IRR amount; presentation only, no FX lookup. */
export function formatIrr(amount: number, locale = "fa-IR"): string {
  assertIrrInteger(amount, "IRR amount");
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(amount);
}
