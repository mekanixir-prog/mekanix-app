import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculatePrice, isProductionPricingApproved, type PricingInput } from "@/lib/pricing";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    servicePackage: { findUnique: vi.fn().mockResolvedValue(null) },
    platformSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    pricingSnapshot: { create: vi.fn().mockResolvedValue({ id: "snapshot-1" }) },
  },
}));
vi.mock("@/lib/db-access", () => ({ getDbForLib: vi.fn(async () => dbMock) }));

const base: PricingInput = {
  vehicleType: "CAR", serviceCode: "diagnostic", laborHours: 1, partsCost: 100_000,
  travelDistanceKm: 10, isEmergency: false,
};

describe("fixed-fee pricing engine", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses passenger fixed labor, inspection, and included-distance dispatch fees", async () => {
    const result = await calculatePrice(base);
    expect(result.labor).toBe(8_000_000);
    expect(result.inspection).toBe(6_000_000);
    expect(result.travel).toBe(5_000_000);
    expect(result.parts).toBe(100_000);
    expect(result.emergency).toBe(0);
    expect(result.subtotal).toBe(19_100_000);
    expect(result.taxRate).toBe(0);
    expect(result.taxTotal).toBe(0);
    expect(result.total).toBe(19_100_000);
    expect(result.pricingVersion).toBe("rate-card-1");
    expect(result.breakdown.serviceCode).toBe("diagnostic");
    expect(result.breakdown.assetClass).toBe("passenger");
  });

  it("uses fixed heavy-equipment rates, not hourly multipliers", async () => {
    const result = await calculatePrice({ ...base, vehicleType: "EXCAVATOR" });
    expect(result.labor).toBe(35_000_000);
    expect(result.inspection).toBe(20_000_000);
    expect(result.travel).toBe(20_000_000);
    expect(result.breakdown.assetClass).toBe("heavy");
  });

  it("charges distance only beyond the included ten kilometres", async () => {
    const result = await calculatePrice({ ...base, travelDistanceKm: 13 });
    expect(result.travel).toBe(5_300_000);
  });

  it("adds the emergency percentage to labor only", async () => {
    const result = await calculatePrice({ ...base, isEmergency: true });
    expect(result.emergency).toBe(2_400_000);
    expect(result.subtotal).toBe(21_500_000);
    expect(result.breakdown.emergencyMultiplier).toBe(1.3);
  });

  it("does not apply VIP discounts to repair labor or parts", async () => {
    await expect(calculatePrice({ ...base, vipDiscountPercent: 10 })).rejects.toThrow("VIP does not discount repairs or parts");
  });

  it("rejects unknown vehicle types instead of charging the heavy-equipment rate", async () => {
    await expect(calculatePrice({ ...base, vehicleType: "OTHER" })).rejects.toThrow("نوع وسیله");
  });

  it("rejects a service not offered for the selected asset class", async () => {
    await expect(calculatePrice({ ...base, serviceCode: "hydraulic" })).rejects.toThrow("در نرخ‌نامه تعریف نشده");
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid parts amount %s", async partsCost => {
      await expect(calculatePrice({ ...base, partsCost })).rejects.toThrow();
    },
  );
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid distance %s", async travelDistanceKm => {
      await expect(calculatePrice({ ...base, travelDistanceKm })).rejects.toThrow();
    },
  );
});

describe("production pricing approval gate", () => {
  it("allows development/test but requires explicit production approval", () => {
    expect(isProductionPricingApproved("test", undefined)).toBe(true);
    expect(isProductionPricingApproved("development", "false")).toBe(true);
    expect(isProductionPricingApproved("production", undefined)).toBe(false);
    expect(isProductionPricingApproved("production", "false")).toBe(false);
    expect(isProductionPricingApproved("production", "true")).toBe(true);
  });

  it("fails before database access when production approval is absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEKANIX_PRICING_IRR_APPROVED", "false");
    try {
      await expect(calculatePrice(base)).rejects.toThrow("Production IRR pricing is disabled");
    } finally { vi.unstubAllEnvs(); }
  });
});
