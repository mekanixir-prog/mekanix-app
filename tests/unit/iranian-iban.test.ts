import { describe, expect, it } from "vitest";
import { isValidIranianSheba } from "@/lib/iranian-iban";

describe("isValidIranianSheba", () => {
  it("accepts a checksum-valid Iranian IBAN", () => {
    expect(isValidIranianSheba("IR062960000000100324200001")).toBe(true);
    expect(isValidIranianSheba(" IR06 2960 0000 0010 0324 2000 01 ")).toBe(true);
  });

  it("rejects invalid checksum, malformed length and non-string values", () => {
    expect(isValidIranianSheba("IR002960000000100324200001")).toBe(false);
    expect(isValidIranianSheba("IR06296000000010032420000")).toBe(false);
    expect(isValidIranianSheba(null)).toBe(false);
    expect(isValidIranianSheba(123)).toBe(false);
  });
});
