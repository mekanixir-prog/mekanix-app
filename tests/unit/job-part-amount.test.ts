import { describe, expect, it } from "vitest";
import { getJobPartAmountError } from "@/lib/money/job-part-amount";

describe("job-part integer IRR validation", () => {
  it("accepts a positive safe-integer quantity and a non-negative integer IRR price", () => {
    expect(getJobPartAmountError(1, 0)).toBeNull();
    expect(getJobPartAmountError(3, 125_000)).toBeNull();
    expect(getJobPartAmountError(1, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("rejects a line total that exceeds the safe integer IRR range", () => {
    expect(getJobPartAmountError(2, Number.MAX_SAFE_INTEGER)).toBe(
      "PART_LINE_TOTAL_EXCEEDS_SAFE_INTEGER_IRR",
    );
    expect(getJobPartAmountError(1, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null, undefined])(
    "rejects invalid quantity %s",
    (quantity) => {
      expect(getJobPartAmountError(quantity, 100)).toBe(
        "PART_QUANTITY_MUST_BE_POSITIVE_INTEGER",
      );
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100", null, undefined, NaN, Infinity])(
    "rejects invalid unit price %s",
    (unitPrice) => {
      expect(getJobPartAmountError(1, unitPrice)).toBe(
        "PART_UNIT_PRICE_MUST_BE_NON_NEGATIVE_INTEGER_IRR",
      );
    },
  );
});
