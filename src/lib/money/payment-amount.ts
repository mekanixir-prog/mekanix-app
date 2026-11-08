import Decimal from "decimal.js";

export type InvoicePaymentAmountErrorCode =
  | "PAYMENT_CURRENCY_NOT_IRR"
  | "PAYMENT_AMOUNT_NOT_INTEGER_IRR";

/** Validate the exact persisted representation; never round through Number first. */
export function getInvoicePaymentAmountError(
  currency: unknown,
  amount: unknown,
): InvoicePaymentAmountErrorCode | null {
  if (currency !== "IRR") return "PAYMENT_CURRENCY_NOT_IRR";

  if (
    amount === null ||
    amount === undefined ||
    (typeof amount !== "number" &&
      typeof amount !== "string" &&
      typeof amount !== "bigint" &&
      typeof amount !== "object")
  ) {
    return "PAYMENT_AMOUNT_NOT_INTEGER_IRR";
  }

  try {
    const raw = typeof amount === "object"
      ? amount.toString()
      : String(amount);
    const exact = new Decimal(raw);
    if (
      !exact.isFinite() ||
      !exact.isInteger() ||
      !exact.gt(0) ||
      exact.gt(Number.MAX_SAFE_INTEGER)
    ) {
      return "PAYMENT_AMOUNT_NOT_INTEGER_IRR";
    }
    return null;
  } catch {
    return "PAYMENT_AMOUNT_NOT_INTEGER_IRR";
  }
}
