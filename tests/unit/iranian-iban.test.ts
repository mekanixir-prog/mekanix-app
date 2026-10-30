import { describe, expect, it } from "vitest";
import { isValidIranianSheba } from "@/lib/iranian-iban";

describe("Iranian Sheba validation", () => {
  it("accepts a valid Iranian IBAN with a correct mod-97 checksum", () => {
    expect(isValidIranianSheba("IR062960000000100324200001")).toBe(true);
  });

  it("accepts spaces and hyphens used for display formatting", () => {
    expect(isValidIranianSheba("IR06 2960-0000 0010 0324 2000 01")).toBe(true);
  });

  it("rejects a structurally correct IBAN with an invalid checksum", () => {
    expect(isValidIranianSheba("IR002960000000100324200001")).toBe(false);
  });

  it("rejects non-Iranian and malformed values", () => {
    expect(isValidIranianSheba("DE89370400440532013000")).toBe(false);
    expect(isValidIranianSheba("IR123")).toBe(false);
    expect(isValidIranianSheba(null)).toBe(false);
  });
});
