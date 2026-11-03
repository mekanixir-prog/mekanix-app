import Decimal from "decimal.js";

/**
 * Canonical, policy-neutral money primitives for Iranian Rial (IRR).
 *
 * This module validates and calculates integer IRR values and provides an
 * explicit presentation-only IRR-to-Toman formatter. It does not infer
 * currencies, apply FX rates, or define business tariffs. Owner approval of
 * the IRR unit does not prove legacy-row provenance or authorize using these
 * helpers on an unclassified historical amount.
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

export function assertIrrSignedInteger(
  value: unknown,
  context = "IRR amount",
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${context} must be a safe integer number of IRR`);
  }
}

export function addIrrSigned(...amounts: number[]): number {
  let total = 0;

  for (const amount of amounts) {
    assertIrrSignedInteger(amount, "IRR ledger delta");
    const next = total + amount;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("IRR signed addition exceeds the safe integer range");
    }
    total = next;
  }

  return total;
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

/** Format an already validated IRR amount; presentation only, no FX lookup. */
export function formatIrr(amount: number, locale = "fa-IR"): string {
  // Ledger entries and balance adjustments may be signed; formatting accepts
  // either sign while payable/request validators remain non-negative.
  assertIrrSignedInteger(amount, "IRR amount");
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format a verified integer IRR amount as Toman for presentation only.
 * The conversion is exact (10 IRR = 1 Toman); the optional tenth is retained
 * because one IRR equals 0.1 Toman. This must not be used to reinterpret
 * unclassified legacy values or to parse Toman API input.
 */
export function formatTomanFromIrr(amount: number, locale = "fa-IR"): string {
  assertIrrSignedInteger(amount, "IRR amount");

  const signed = BigInt(amount);
  const ten = BigInt(10);
  const zero = BigInt(0);
  const negative = signed < zero;
  const absolute = negative ? -signed : signed;
  const wholeToman = absolute / ten;
  const tenthToman = absolute % ten;

  const integerFormatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  });
  const integerText = integerFormatter.format(wholeToman);
  if (tenthToman === 0n) {
    if (!negative) return integerText;
    const minus = integerFormatter.formatToParts(BigInt(-1)).find((part) => part.type === "minusSign")?.value ?? "-";
    return minus + integerText;
  }

  const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ".";
  const fraction = new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumFractionDigits: 0,
  }).format(Number(tenthToman));
  const minus = negative
    ? integerFormatter.formatToParts(-1n).find((part) => part.type === "minusSign")?.value ?? "-"
    : "";

  return minus + integerText + decimal + fraction;
}
