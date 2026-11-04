import { describe, expect, it } from "vitest";
import { fmtMoney } from "@/lib/format";

describe("fmtMoney", () => {
  it("formats IRR as the stored amount without applying an exchange rate", () => {
    expect(fmtMoney(125_000, "IRR", "en")).toBe("﷼125,000");
    expect(fmtMoney(125_000, "IRR", "fa")).toBe("﷼۱۲۵،۰۰۰");
  });

  it("preserves the declared USD currency for Persian and English users", () => {
    expect(fmtMoney(1_250.5, "USD", "en")).toBe("$1,250.50");
    expect(fmtMoney(1_250.5, "USD", "fa")).toBe("$۱۲۵۰.۵۰");
  });

  it("does not silently coerce missing, non-finite, fractional, or unsafe IRR values", () => {
    expect(fmtMoney(Number.NaN, "IRR", "en")).toBe("—");
    expect(fmtMoney(Number.POSITIVE_INFINITY, "IRR", "en")).toBe("—");
    expect(fmtMoney(1_250.5, "IRR", "en")).toBe("—");
    expect(fmtMoney(Number.MAX_SAFE_INTEGER + 1, "IRR", "en")).toBe("—");
  });
});
