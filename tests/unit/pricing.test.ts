// MEKANIX Phase 6 — Unit tests for the pricing engine (@/lib/pricing)
//
// FinalPrice = Labor + Parts + Travel + Emergency - Discount
//   subtotal (returned) = Labor + Parts + Travel + Emergency   (BEFORE discount)
//   discount            = subtotal × vipPercent / 100
//   afterDiscount       = subtotal − discount                  (implicit)
//   taxTotal            = afterDiscount × 0.09
//   total               = afterDiscount + taxTotal
//
// Covers:
//   - calculatePrice returns correct breakdown for CAR with no emergency
//   - Emergency adds 50% surcharge (multiplier 1.5)
//   - VIP discount reduces the total (subtotal stays pre-discount)
//   - Heavy machinery (TRUCK) has a higher labor rate (1.5x)
//   - Tax is 9% of the after-discount subtotal
//   - All amounts are rounded to integers
//   - Decimal-safe arithmetic (v2.1): exact money math via decimal.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { calculatePrice, type PricingInput } from "@/lib/pricing";

// Mock the db module — calculatePrice only calls db.servicePackage.findUnique
// when packageId is provided. The pricing math itself is pure.
vi.mock("@/lib/db", () => ({
  db: {
    servicePackage: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    pricingSnapshot: {
      create: vi.fn(),
    },
  },
}));

// Base input that produces a known-good calculation for a CAR.
// We'll spread + override fields per-test.
const baseInput: PricingInput = {
  vehicleType: "CAR",
  laborHours: 2,
  partsCost: 100_000,
  travelDistanceKm: 10,
  isEmergency: false,
};

// Expected breakdown for baseInput (CAR, no emergency, no VIP):
//   laborRate = 50000 * 1.0 = 50000
//   labor     = 50000 * 2   = 100000
//   parts     = 100000
//   travel    = 15000 + 10 * 2000 = 35000
//   emergency = 0
//   subtotal  = 100000 + 100000 + 35000 + 0 = 235000   (BEFORE discount)
//   discount  = 0
//   afterDiscount = 235000 - 0 = 235000               (implicit)
//   taxTotal  = 235000 * 0.09 = 21150
//   total     = 235000 + 21150 = 256150
const BASE_LABOR = 100_000;
const BASE_PARTS = 100_000;
const BASE_TRAVEL = 35_000;
const BASE_PRE_DISCOUNT = BASE_LABOR + BASE_PARTS + BASE_TRAVEL; // 235_000 (labor + parts + travel)
const BASE_SUBTOTAL = BASE_PRE_DISCOUNT; // no emergency, no VIP → subtotal = preDiscount
const BASE_TAX = Math.round(BASE_SUBTOTAL * 0.09); // 21150
const BASE_TOTAL = Math.round(BASE_SUBTOTAL + BASE_TAX); // 256150

describe("pricing — calculatePrice base breakdown (CAR, no emergency)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the expected labor / parts / travel / subtotal / tax / total", async () => {
    const result = await calculatePrice(baseInput);

    expect(result.labor).toBe(BASE_LABOR);
    expect(result.parts).toBe(BASE_PARTS);
    expect(result.travel).toBe(BASE_TRAVEL);
    expect(result.emergency).toBe(0);
    expect(result.discount).toBe(0);
    expect(result.subtotal).toBe(BASE_SUBTOTAL);
    expect(result.taxRate).toBe(0.09);
    expect(result.taxTotal).toBe(BASE_TAX);
    expect(result.total).toBe(BASE_TOTAL);
    expect(result.currency).toBe("IRR");
    // pricingVersion bumped to "2.1" for Decimal-safe arithmetic.
    expect(result.pricingVersion).toBe("2.1");
  });

  it("breakdown includes the laborRate / multipliers / hours", async () => {
    const result = await calculatePrice(baseInput);

    expect(result.breakdown.laborRate).toBe(50_000); // base * CAR(1.0)
    expect(result.breakdown.laborHours).toBe(2);
    expect(result.breakdown.travelRate).toBe(2_000);
    expect(result.breakdown.travelDistanceKm).toBe(10);
    expect(result.breakdown.emergencyMultiplier).toBe(1);
    expect(result.breakdown.vipDiscountPercent).toBe(0);
  });
});

describe("pricing — monetary input validation", () => {
  it("rejects fractional or negative parts costs", async () => {
    await expect(calculatePrice({ ...baseInput, partsCost: 100_000.5 })).rejects.toThrow();
    await expect(calculatePrice({ ...baseInput, partsCost: -1 })).rejects.toThrow();
  });

  it("rejects invalid labor hours and travel distances", async () => {
    await expect(calculatePrice({ ...baseInput, laborHours: Number.NaN })).rejects.toThrow();
    await expect(calculatePrice({ ...baseInput, laborHours: -1 })).rejects.toThrow();
    await expect(calculatePrice({ ...baseInput, travelDistanceKm: Number.POSITIVE_INFINITY })).rejects.toThrow();
    await expect(calculatePrice({ ...baseInput, travelDistanceKm: -1 })).rejects.toThrow();
  });

  it("rejects discounts outside the supported percentage range", async () => {
    await expect(calculatePrice({ ...baseInput, vipDiscountPercent: 101 })).rejects.toThrow();
    await expect(calculatePrice({ ...baseInput, vipDiscountPercent: -1 })).rejects.toThrow();
  });

  it("rejects outputs outside the safe integer IRR range", async () => {
    await expect(calculatePrice({ ...baseInput, laborHours: Number.MAX_VALUE })).rejects.toThrow();
  });
});

describe("pricing — emergency surcharge", () => {
  it("Emergency adds 50% surcharge on (labor + parts + travel)", async () => {
    const result = await calculatePrice({ ...baseInput, isEmergency: true });

    // emergency = (labor + parts + travel) * (1.5 - 1) = 235000 * 0.5 = 117500
    const expectedEmergency = Math.round(BASE_PRE_DISCOUNT * 0.5);
    expect(result.emergency).toBe(expectedEmergency);

    // subtotal (before discount) = preDiscount + emergency = 235000 + 117500 = 352500
    const expectedSubtotal = BASE_PRE_DISCOUNT + expectedEmergency;
    // No VIP → afterDiscount = subtotal
    const expectedAfterDiscount = expectedSubtotal;
    const expectedTax = Math.round(expectedAfterDiscount * 0.09);
    const expectedTotal = Math.round(expectedAfterDiscount + expectedTax);

    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.taxTotal).toBe(expectedTax);
    expect(result.total).toBe(expectedTotal);
    expect(result.breakdown.emergencyMultiplier).toBe(1.5);
  });
});

describe("pricing — VIP discount reduces the total (subtotal stays pre-discount)", () => {
  it("10% VIP discount reduces total; subtotal stays at preDiscount", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vipDiscountPercent: 10,
    });

    // discount = subtotal * 10% = 23500
    const expectedDiscount = Math.round(BASE_PRE_DISCOUNT * 0.10);
    expect(result.discount).toBe(expectedDiscount);

    // subtotal (BEFORE discount) = preDiscount (no emergency)
    const expectedSubtotal = BASE_PRE_DISCOUNT;
    // afterDiscount = subtotal - discount = 211500
    const expectedAfterDiscount = expectedSubtotal - expectedDiscount;
    const expectedTax = Math.round(expectedAfterDiscount * 0.09);
    const expectedTotal = Math.round(expectedAfterDiscount + expectedTax);

    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.taxTotal).toBe(expectedTax);
    expect(result.total).toBe(expectedTotal);
    expect(result.breakdown.vipDiscountPercent).toBe(10);

    // Total is strictly less than the non-discounted total
    expect(result.total).toBeLessThan(BASE_TOTAL);
  });

  it("50% VIP discount halves the afterDiscount; subtotal unchanged", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vipDiscountPercent: 50,
    });

    const expectedDiscount = Math.round(BASE_PRE_DISCOUNT * 0.50);
    expect(result.discount).toBe(expectedDiscount);

    // subtotal stays at preDiscount — discount is reported separately.
    const expectedSubtotal = BASE_PRE_DISCOUNT;
    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.total).toBeLessThan(BASE_TOTAL);
  });

  it("100% VIP discount zeroes out afterDiscount + total; subtotal unchanged", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vipDiscountPercent: 100,
    });

    // discount = subtotal = 235000; afterDiscount = 0; taxTotal = 0; total = 0
    expect(result.discount).toBe(BASE_PRE_DISCOUNT);
    // subtotal still equals preDiscount — semantic is "before discount".
    expect(result.subtotal).toBe(BASE_PRE_DISCOUNT);
    expect(result.taxTotal).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("pricing — heavy machinery (TRUCK) has higher labor rate", () => {
  it("TRUCK labor rate = base * 1.5 = 75000/hour", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vehicleType: "TRUCK",
    });

    // laborRate = 50000 * 1.5 = 75000
    expect(result.breakdown.laborRate).toBe(75_000);
    // labor = 75000 * 2 = 150000 (vs 100000 for CAR)
    expect(result.labor).toBe(150_000);
    // TRUCK total should exceed CAR total
    const carResult = await calculatePrice(baseInput);
    expect(result.total).toBeGreaterThan(carResult.total);
  });

  it("EXCAVATOR labor rate = base * 2.0 = 100000/hour (heavy machinery)", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vehicleType: "EXCAVATOR",
    });

    expect(result.breakdown.laborRate).toBe(100_000);
    expect(result.labor).toBe(200_000);
  });

  it("Unknown vehicle type falls back to default 1.3x multiplier", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vehicleType: "ALIEN_CRAFT",
    });

    // 50000 * 1.3 = 65000
    expect(result.breakdown.laborRate).toBe(65_000);
  });
});

describe("pricing — tax is 9% of after-discount subtotal", () => {
  it("taxRate is 0.09", async () => {
    const result = await calculatePrice(baseInput);
    expect(result.taxRate).toBe(0.09);
  });

  it("taxTotal = round((subtotal - discount) * 0.09) — no discount case", async () => {
    const result = await calculatePrice(baseInput);
    // No discount → afterDiscount = subtotal
    expect(result.taxTotal).toBe(Math.round(result.subtotal * 0.09));
  });

  it("tax scales correctly with emergency surcharge (no VIP)", async () => {
    const result = await calculatePrice({ ...baseInput, isEmergency: true });
    // No discount → afterDiscount = subtotal
    expect(result.taxTotal).toBe(Math.round(result.subtotal * 0.09));
  });

  it("tax is computed on the AFTER-discount amount when VIP applies", async () => {
    const result = await calculatePrice({
      ...baseInput,
      vipDiscountPercent: 15,
    });
    // afterDiscount = subtotal - discount
    const expectedAfterDiscount = result.subtotal - result.discount;
    expect(result.taxTotal).toBe(Math.round(expectedAfterDiscount * 0.09));
  });
});

describe("pricing — all amounts are rounded to integers", () => {
  it("every numeric output field is an integer", async () => {
    const result = await calculatePrice({
      ...baseInput,
      isEmergency: true,
      vipDiscountPercent: 17,
    });

    const numericFields = [
      result.labor,
      result.parts,
      result.travel,
      result.emergency,
      result.discount,
      result.subtotal,
      result.taxTotal,
      result.total,
    ];

    for (const n of numericFields) {
      expect(Number.isInteger(n)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decimal-safe arithmetic (v2.1)
//
// As of pricingVersion "2.1", calculatePrice uses decimal.js for all money
// math. This avoids floating-point errors that plague `number` arithmetic
// (e.g., `0.1 + 0.2 === 0.30000000000000004`). The tests below verify the
// implementation produces exact results — including for inputs that would
// silently corrupt a `number`-based calculation.
// ─────────────────────────────────────────────────────────────────────────────
describe("pricing — Decimal-safe arithmetic (v2.1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches an independent Decimal reference computation (base case)", async () => {
    const input = baseInput;
    const result = await calculatePrice(input);

    // Independent reference computation using Decimal directly.
    const refLaborRate = new Decimal(50000).mul(1.0); // CAR multiplier
    const refLabor = refLaborRate.mul(input.laborHours);
    const refParts = new Decimal(input.partsCost);
    const refTravel = new Decimal(15000).add(new Decimal(2000).mul(input.travelDistanceKm));
    const refPreDiscount = refLabor.add(refParts).add(refTravel);
    const refEmergency = new Decimal(0); // not emergency
    const refSubtotal = refPreDiscount.add(refEmergency);
    const refDiscount = refSubtotal.mul(0).div(100); // 0% VIP
    const refAfterDiscount = refSubtotal.sub(refDiscount);
    const refTax = refAfterDiscount.mul(0.09);
    const refTotal = refAfterDiscount.add(refTax);

    expect(result.labor).toBe(refLabor.round().toNumber());
    expect(result.parts).toBe(refParts.round().toNumber());
    expect(result.travel).toBe(refTravel.round().toNumber());
    expect(result.emergency).toBe(refEmergency.round().toNumber());
    expect(result.discount).toBe(refDiscount.round().toNumber());
    expect(result.subtotal).toBe(refSubtotal.round().toNumber());
    expect(result.taxTotal).toBe(refTax.round().toNumber());
    expect(result.total).toBe(refTotal.round().toNumber());
  });

  it("matches Decimal reference for non-round inputs (17% VIP + emergency)", async () => {
    const input: PricingInput = {
      vehicleType: "TRUCK",
      laborHours: 1.7,
      partsCost: 99_999,
      travelDistanceKm: 7,
      isEmergency: true,
      vipDiscountPercent: 17,
    };
    const result = await calculatePrice(input);

    // Independent Decimal reference.
    const refLaborRate = new Decimal(50000).mul(1.5); // TRUCK multiplier
    const refLabor = refLaborRate.mul(input.laborHours);
    const refParts = new Decimal(input.partsCost);
    const refTravel = new Decimal(15000).add(new Decimal(2000).mul(input.travelDistanceKm));
    const refPreDiscount = refLabor.add(refParts).add(refTravel);
    const refEmergency = refPreDiscount.mul(0.5); // EMERGENCY_MULTIPLIER - 1
    const refSubtotal = refPreDiscount.add(refEmergency);
    const refDiscount = refSubtotal.mul(input.vipDiscountPercent!).div(100);
    const refAfterDiscount = refSubtotal.sub(refDiscount);
    const refTax = refAfterDiscount.mul(0.09);
    const refTotal = refAfterDiscount.add(refTax);

    expect(result.labor).toBe(refLabor.round().toNumber());
    expect(result.parts).toBe(refParts.round().toNumber());
    expect(result.travel).toBe(refTravel.round().toNumber());
    expect(result.emergency).toBe(refEmergency.round().toNumber());
    expect(result.discount).toBe(refDiscount.round().toNumber());
    expect(result.subtotal).toBe(refSubtotal.round().toNumber());
    expect(result.taxTotal).toBe(refTax.round().toNumber());
    expect(result.total).toBe(refTotal.round().toNumber());
  });

  it("subtotal is the PRE-discount sum (labor + parts + travel + emergency)", async () => {
    const result = await calculatePrice({
      ...baseInput,
      isEmergency: true,
      vipDiscountPercent: 25,
    });

    // subtotal = labor + parts + travel + emergency, NOT (subtotal - discount).
    const expectedSubtotal = result.labor + result.parts + result.travel + result.emergency;
    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.discount).toBeGreaterThan(0);
  });

  it("total = (subtotal - discount) + taxTotal — invariant holds with Decimal", async () => {
    const result = await calculatePrice({
      ...baseInput,
      isEmergency: true,
      vipDiscountPercent: 33,
    });

    // The post-discount + tax invariant. Floating-point arithmetic would
    // sometimes produce a +1 or -1 rial drift here; Decimal makes it exact.
    const expectedTotal = result.subtotal - result.discount + result.taxTotal;
    expect(result.total).toBe(expectedTotal);
  });

  it("no floating-point drift on the discount for non-round percentages", async () => {
    // 17% of 235000 = 39950 exactly. In `number` arithmetic:
    //   235000 * 0.17 = 39950.00000000001   (float error)
    //   Math.round(39950.00000000001) = 39950  (corrected by rounding)
    // With Decimal: 235000 * 17 / 100 = 39950 exactly (no rounding needed).
    const result = await calculatePrice({
      ...baseInput,
      vipDiscountPercent: 17,
    });
    expect(result.discount).toBe(39_950);
  });

  it("no floating-point drift on tax for non-round subtotals", async () => {
    // Construct an input where subtotal * 0.09 would have float drift.
    //   subtotal = 50000 * 1.0 * 3 + 12345 + (15000 + 13 * 2000)
    //            = 150000 + 12345 + 41000 = 203345
    //   203345 * 0.09 = 18301.05 (float: 18301.050000000003)
    //   Math.round → 18301
    //   Decimal: 203345 * 0.09 = 18301.05 → round → 18301
    const result = await calculatePrice({
      vehicleType: "CAR",
      laborHours: 3,
      partsCost: 12_345,
      travelDistanceKm: 13,
      isEmergency: false,
    });
    expect(result.subtotal).toBe(203_345);
    expect(result.taxTotal).toBe(18_301);
    expect(result.total).toBe(203_345 + 18_301);
  });
});
