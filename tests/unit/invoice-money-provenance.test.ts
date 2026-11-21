import { describe, expect, it } from "vitest";
import {
  areInvoicePriceSourcesVerified,
  areJobPartPriceSourcesVerified,
  areTechnicianPriceSourcesVerified,
  isInvoicePricingPolicyApproved,
  toSafeIntegerIrr,
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


describe("independent technician and invoice policy provenance", () => {
  it("keeps commercial approval separate from row-level technician evidence", () => {
    expect(isInvoicePricingPolicyApproved({ NODE_ENV: "production" })).toBe(false);
    expect(isInvoicePricingPolicyApproved({
      NODE_ENV: "production",
      MEKANIX_PRICING_IRR_APPROVED: "true",
    })).toBe(true);
    expect(areTechnicianPriceSourcesVerified({
      financialUnitStatus: "VERIFIED_IRR",
      hourlyRate: 125_000,
      travelFeeBase: "50000",
      inspectionFee: 20_000,
      inspectionFeeHeavy: 50_000,
    })).toBe(true);
    expect(areTechnicianPriceSourcesVerified({
      financialUnitStatus: "UNVERIFIED",
      hourlyRate: 125_000,
      travelFeeBase: 50_000,
      inspectionFee: 20_000,
      inspectionFeeHeavy: 50_000,
    })).toBe(false);
    expect(areTechnicianPriceSourcesVerified({
      financialUnitStatus: "VERIFIED_IRR",
      hourlyRate: "125000.5",
      travelFeeBase: 50_000,
      inspectionFee: 20_000,
      inspectionFeeHeavy: 50_000,
    })).toBe(false);
  });

  it("parses only exact safe integer IRR values", () => {
    expect(toSafeIntegerIrr("125000.00")).toBe(125000);
    expect(toSafeIntegerIrr("125000.1")).toBe(null);
    expect(toSafeIntegerIrr(Number.MAX_SAFE_INTEGER + 1)).toBe(null);
    expect(toSafeIntegerIrr(-1)).toBe(null);
  });
});
