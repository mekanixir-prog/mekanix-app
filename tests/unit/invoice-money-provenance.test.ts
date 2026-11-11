import { describe, expect, it } from "vitest";
import {
  areInvoicePriceSourcesVerified,
  areJobPartPriceSourcesVerified,
} from "@/lib/money/provenance";

describe("production invoice money provenance", () => {
  it("keeps development and test invoice workflows available", () => {
    expect(areInvoicePriceSourcesVerified({ NODE_ENV: "test" })).toBe(true);
    expect(areJobPartPriceSourcesVerified([])).toBe(true);
  });

  it("requires both an approved IRR rate card and verified technician fee units", () => {
    expect(areInvoicePriceSourcesVerified({ NODE_ENV: "production" })).toBe(false);
    expect(areInvoicePriceSourcesVerified({
      NODE_ENV: "production",
      MEKANIX_PRICING_IRR_APPROVED: "true",
    })).toBe(false);
    expect(areInvoicePriceSourcesVerified({
      NODE_ENV: "production",
      MEKANIX_PRICING_IRR_APPROVED: "true",
      MEKANIX_TECHNICIAN_FEES_IRR_VERIFIED: "true",
    })).toBe(true);
  });

  it("requires every part row to independently attest safe integer IRR", () => {
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
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: "125000.5",
      quantity: 2,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: Number.MAX_SAFE_INTEGER,
      quantity: 2,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: 100,
      quantity: 0,
    }])).toBe(false);
    expect(areJobPartPriceSourcesVerified([{
      financialUnitStatus: "VERIFIED_IRR",
      unitPrice: null,
      quantity: 1,
    }])).toBe(false);
  });
});
