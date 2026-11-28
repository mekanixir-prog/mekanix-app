import { describe, expect, it } from "vitest";
import { getPhoneLookupVariants, normalizePhoneForStorage } from "@/lib/phone-normalization";

describe("phone identity canonicalization contract", () => {
  it.each([
    ["0912 345 6789", "+989123456789"],
    ["+98-913-456-7890", "+989134567890"],
    ["(0914) 567-8901", "+989145678901"],
    ["+98.916.789.0123", "+989167890123"],
    ["+1 (415) 224-1180", "+14152241180"],
    ["+1.650.555.0100", "+16505550100"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(normalizePhoneForStorage(input)).toBe(expected);
  });

  it("uses the same bounded legacy lookup variants after punctuation normalization", () => {
    const variants = getPhoneLookupVariants("+98.912.123.4567");
    expect(variants).toContain("+989121234567");
    expect(variants).toContain("989121234567");
    expect(variants).toContain("09121234567");
  });

  it("preserves unsupported non-Iranian values using the documented compact fallback", () => {
    expect(normalizePhoneForStorage("555.0100")).toBe("555.0100");
  });
});
