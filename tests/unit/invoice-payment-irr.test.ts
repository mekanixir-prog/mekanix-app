import { describe, expect, it } from "vitest";
import { getInvoicePaymentAmountError } from "@/lib/money/payment-amount";

describe("invoice payment IRR contract", () => {
  it("accepts only positive safe integer IRR amounts", () => {
    expect(getInvoicePaymentAmountError("IRR", 1)).toBeNull();
    expect(getInvoicePaymentAmountError("IRR", 5_000_000)).toBeNull();
  });

  it("rejects non-IRR invoice currency", () => {
    expect(getInvoicePaymentAmountError("USD", 5_000_000)).toBe("PAYMENT_CURRENCY_NOT_IRR");
    expect(getInvoicePaymentAmountError("IRT", 5_000_000)).toBe("PAYMENT_CURRENCY_NOT_IRR");
    expect(getInvoicePaymentAmountError(null, 5_000_000)).toBe("PAYMENT_CURRENCY_NOT_IRR");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid IRR amount %s",
    (amount) => {
      expect(getInvoicePaymentAmountError("IRR", amount)).toBe("PAYMENT_AMOUNT_NOT_INTEGER_IRR");
    },
  );
});
