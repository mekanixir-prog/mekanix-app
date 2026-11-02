import Decimal from "decimal.js";

/**
 * Canonical, policy-neutral money primitives for Iranian Rial (IRR).
 *
 * This module validates and calculates integer IRR values only. It does not
 * infer currencies, convert Toman, apply FX rates, or define business tariffs.
 */

export type IrrRoundingMode = "half-up" | "down" | "up";

export interface IrrValidationOptions {
  allowZero?: boolean;
}

const MAX_IRR = Number.MAX_SAFE_INTEGER;

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

  const result = new Decimal(amount)
    .mul(numerator)
    .div(denominator)
    .toDecimalPlaces(0, decimalRounding);

  if (!result.isInteger() || result.isNegative() || result.greaterThan(MAX_IRR)) {
    throw new RangeError("IRR ratio result is outside the safe integer range");
  }

  return result.toNumber();
}

/** Format an already validated IRR amount; presentation only, no FX lookup. */
export function formatIrr(amount: number, locale = "fa-IR"): string {
  assertIrrInteger(amount, "IRR amount");
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(amount);
}
