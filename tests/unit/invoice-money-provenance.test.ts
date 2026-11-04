import { describe, expect, it } from "vitest";
import {
  areInvoicePriceSourcesVerified,
  areJobPartPriceSourcesVerified,
} from "@/lib/money/provenance";

describe("production invoice money provenance", () => {
  it("keeps development and test invoice workflows available", () => {
    expect(areInvoicePriceSourcesVerified({ NODE_ENV: "test" })).toBe(true);
    expect(areJobPartPriceSourcesVerified(true, { NODE_ENV: "development" })).toBe(true);
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

  it("requires JobPart provenance only when an invoice contains parts", () => {
    expect(areJobPartPriceSourcesVerified(false, { NODE_ENV: "production" })).toBe(true);
    expect(areJobPartPriceSourcesVerified(true, { NODE_ENV: "production" })).toBe(false);
    expect(areJobPartPriceSourcesVerified(true, {
      NODE_ENV: "production",
      MEKANIX_JOB_PART_IRR_PROVENANCE_VERIFIED: "true",
    })).toBe(true);
  });
});
