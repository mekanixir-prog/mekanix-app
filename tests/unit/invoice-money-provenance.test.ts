import { describe, expect, it } from "vitest";
import {
  areInvoicePriceSourcesVerified,
  areJobPartPriceSourcesVerified,
} from "@/lib/money/provenance";

describe("invoice money source provenance", () => {
  it("requires the technician row to attest verified IRR fees", () => {
    expect(areInvoicePriceSourcesVerified({
      financialUnitStatus: "VERIFIED_IRR",
      hourlyRate: 125_000,
      travelFeeBase: "50000",
    })).toBe(true);
    expect(areInvoicePriceSourcesVerified({
      financialUnitStatus: "UNVERIFIED",
      hourlyRate: 125_000,
      travelFeeBase: 50_000,
    })).toBe(false);
    expect(areInvoicePriceSourcesVerified({
      financialUnitStatus: "VERIFIED_IRR",
      hourlyRate: "125000.5",
      travelFeeBase: 50_000,
    })).toBe(false);
    expect(areInvoicePriceSourcesVerified({
      financialUnitStatus: "VERIFIED_IRR",
      hourlyRate: Number.MAX_SAFE_INTEGER + 1,
      travelFeeBase: 50_000,
    })).toBe(false);
  });

  it("accepts no parts but requires every existing part row to be independently verified", () => {
    expect(areJobPartPriceSourcesVerified([])).toBe(true);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: "125000.00",
      quantity: 2,
    }])).toBe(true);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "UNVERIFIED",
      unitPrice: 125_000,
      quantity: 2,
    }])).toBe(false);
  });

  it("rejects fractional, unsafe, invalid, and overflowing part amounts", () => {
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: "125000.1",
      quantity: 1,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: Number.MAX_SAFE_INTEGER + 1,
      quantity: 1,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: Number.MAX_SAFE_INTEGER,
      quantity: 2,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: 1_000,
      quantity: 0,
    }])).toBe(false);
  });
});
