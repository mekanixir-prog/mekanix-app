import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING_RATE_CARD, normalizeVehicleAssetClass, validatePricingRateCard } from "@/lib/pricing-rate-card";
describe("MEKANIX editable rate card", () => {
  const editable = () => {
    const { schemaVersion, version, currency, displayCurrency, effectiveAt, updatedAt, updatedBy, ...rest } = DEFAULT_PRICING_RATE_CARD;
    return rest;
  };
  it("has separate integer IRR schedules for passenger and heavy assets", () => {
    expect(DEFAULT_PRICING_RATE_CARD.fees.passenger.visitBaseIrr).toBe(5_000_000);
    expect(DEFAULT_PRICING_RATE_CARD.fees.heavy.visitBaseIrr).toBe(20_000_000);
    expect(normalizeVehicleAssetClass("CAR")).toBe("passenger");
    expect(normalizeVehicleAssetClass("EXCAVATOR")).toBe("heavy");
  });
  it("accepts the complete baseline", () => { expect(validatePricingRateCard(editable()).emergencySurchargeBps).toBe(3000); });
  it("rejects fractional and negative IRR values", () => {
    expect(() => validatePricingRateCard({ ...editable(), fees: { ...editable().fees, passenger: { ...editable().fees.passenger, visitBaseIrr: 1.5 } } })).toThrow();
    expect(() => validatePricingRateCard({ ...editable(), fees: { ...editable().fees, heavy: { ...editable().fees.heavy, perKmIrr: -1 } } })).toThrow();
  });
  it("never allows VIP to include repairs or parts", () => {
    expect(() => validatePricingRateCard({ ...editable(), vip: { ...editable().vip, excludesRepairsAndParts: false } })).toThrow();
  });
});
