import { assertIrrInteger } from "./irr";

export type InvoicePaymentAmountErrorCode =
  | "PAYMENT_CURRENCY_NOT_IRR"
  | "PAYMENT_AMOUNT_NOT_INTEGER_IRR";

export function getInvoicePaymentAmountError(
  currency: unknown,
  amount: unknown,
): InvoicePaymentAmountErrorCode | null {
  if (currency !== "IRR") return "PAYMENT_CURRENCY_NOT_IRR";
  try {
    assertIrrInteger(amount, "Invoice payment amount", { allowZero: false });
    return null;
  } catch {
    return "PAYMENT_AMOUNT_NOT_INTEGER_IRR";
  }
}
