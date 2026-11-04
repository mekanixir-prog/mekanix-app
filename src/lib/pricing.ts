// Pricing Engine — calculates service prices per ARCHITECTURE.md §12.
//
// FinalPrice = Labor + Parts + Travel + Emergency - Discount
//
// All amounts are in IRR (Iranian Rial) minor units (toman × 10).
//
// ─────────────────────────────────────────────────────────────────────────────
// Decimal-safe money math (v2.1)
// ─────────────────────────────────────────────────────────────────────────────
// Floating-point `number` arithmetic silently loses precision on money values
// (e.g. `0.1 + 0.2 === 0.30000000000000004`). For a financial system that's a
// bug waiting to happen — especially once percentages, taxes, and emergency
// surcharges compose. So as of pricingVersion "2.1", every money-math
// operation routes through `decimal.js` Decimal. We still convert to
// `number` at the boundary (return type is `number`) so existing callers —
// which expect `number` and persist into Prisma `Decimal` columns — don't
// need to change. The rounding to integer IRR (no fractional unit) is done
// via `Decimal.round()` BEFORE the `toNumber()` cast, so no precision is
// lost in the conversion.
//
// Schema mapping (PricingSnapshot Prisma model):
//   servicePrice  ← labor                (the package-derived service fee)
//   visitPrice    ← travel               (on-site visit / travel fee)
//   laborPrice    ← labor
//   partsPrice    ← parts
//   discount      ← discount             (VIP or promo)
//   taxRate       ← taxRate              (0.09 = 9% VAT)
//   taxTotal      ← taxTotal
//   total         ← total                (subtotal after discount + taxTotal)
//   currency      ← currency             ("IRR")
//   pricingVersion← pricingVersion      ("2.1" — bumped for Decimal-safe)

import Decimal from "decimal.js";
import { getDbForLib } from "./db-access";
import { assertIrrInteger } from "./money/irr";
import { getPricingRateCard, normalizeVehicleAssetClass, type ServiceCode } from "./pricing-rate-card";

/**
 * Production pricing is fail-closed until the canonical IRR rate card has
 * explicit business-owner approval. Development and tests retain demo rates.
 */
export function isProductionPricingApproved(
  nodeEnv = process.env.NODE_ENV,
  approved = process.env.MEKANIX_PRICING_IRR_APPROVED,
): boolean {
  return nodeEnv !== "production" || approved === "true";
}


export interface PricingInput {
  packageId?: string;
  vehicleType: string; // CAR, TRUCK, EXCAVATOR, etc.
  /** Fixed-fee service code. Defaults to diagnostic for legacy callers. */
  serviceCode?: ServiceCode;
  /** @deprecated Kept for API compatibility; fixed-fee pricing ignores elapsed hours. */
  laborHours: number;
  partsCost: number; // sum of parts
  travelDistanceKm: number;
  isEmergency: boolean;
  vipDiscountPercent?: number;
  region?: string; // for region-based pricing
}

export interface PricingBreakdown {
  labor: number;
  parts: number;
  travel: number;
  inspection: number;
  emergency: number;
  discount: number;
  /** Subtotal BEFORE discount (= labor + parts + travel + emergency). */
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  total: number;
  currency: string;
  pricingVersion: string;
  breakdown: {
    laborRate: number;
    laborHours: number;
    serviceCode: string;
    assetClass: "passenger" | "heavy";
    includedDistanceKm: number;
    travelRate: number;
    travelDistanceKm: number;
    emergencyMultiplier: number;
    vipDiscountPercent: number;
  };
}

// Fixed-fee rate card is stored centrally in PlatformSetting and is editable
// from /admin-panel/pricing. All persisted values are integer IRR.
function round(dec: Decimal): number {
  const amount = dec.round().toNumber();
  assertIrrInteger(amount, "Calculated price");
  return amount;
}

export async function calculatePrice(input: PricingInput): Promise<PricingBreakdown> {
  if (!isProductionPricingApproved()) {
    throw new Error("Production IRR pricing is disabled until the canonical rate card is approved");
  }
  if (!Number.isFinite(input.laborHours) || input.laborHours < 0) {
    throw new RangeError("Labor hours must be a finite non-negative number");
  }
  assertIrrInteger(input.partsCost, "Parts cost");
  if (!Number.isFinite(input.travelDistanceKm) || input.travelDistanceKm < 0) {
    throw new RangeError("Travel distance must be a finite non-negative number");
  }
  // VIP never discounts repair labor or parts. Its visit benefit is fulfilled
  // by the subscription/booking flow, not by a percentage discount here.
  const vipPercent = input.vipDiscountPercent ?? 0;
  if (!Number.isFinite(vipPercent) || vipPercent < 0 || vipPercent > 100) {
    throw new RangeError("VIP discount percent must be between 0 and 100");
  }
  if (vipPercent > 0) {
    throw new Error("VIP does not discount repairs or parts; periodic-visit benefits are applied by the booking flow");
  }

  const db = await getDbForLib();
  let packageBasePrice = new Decimal(0);
  if (input.packageId) {
    const pkg = await db.servicePackage.findUnique({ where: { id: input.packageId } });
    if (pkg?.basePrice != null) packageBasePrice = new Decimal(pkg.basePrice.toString());
  }

  const card = await getPricingRateCard();
  const assetClass = normalizeVehicleAssetClass(input.vehicleType);
  const serviceCode = input.serviceCode ?? "diagnostic";
  const fixedLabor = card.serviceFeesIrr[assetClass][serviceCode];
  if (fixedLabor === null || fixedLabor === undefined) {
    throw new Error("این خدمت برای گروه وسیله انتخاب‌شده در نرخ‌نامه تعریف نشده است");
  }
  assertIrrInteger(fixedLabor, "Fixed labor fee");
  const labor = new Decimal(fixedLabor);
  const inspection = new Decimal(card.fees[assetClass].inspectionIrr);
  const distance = new Decimal(input.travelDistanceKm);
  const includedKm = new Decimal(card.fees[assetClass].includedKm);
  const extraKm = Decimal.max(0, distance.sub(includedKm));
  const travel = new Decimal(card.fees[assetClass].visitBaseIrr)
    .add(new Decimal(card.fees[assetClass].perKmIrr).mul(extraKm));
  const parts = new Decimal(input.partsCost);
  const emergencyRate = new Decimal(card.emergencySurchargeBps).div(10_000);
  const emergency = input.isEmergency ? labor.mul(emergencyRate) : new Decimal(0);
  const subtotal = labor.add(parts).add(travel).add(inspection).add(emergency);
  const discount = new Decimal(0);

  if (card.tax.enabled && card.tax.rateBps > 0 && process.env.MEKANIX_TAX_IRR_APPROVED !== "true") {
    throw new Error("Tax calculation is disabled until MEKANIX_TAX_IRR_APPROVED=true and tax policy is reviewed");
  }
  const taxRate = card.tax.enabled ? card.tax.rateBps / 10_000 : 0;
  const taxTotal = card.tax.enabled ? subtotal.mul(card.tax.rateBps).div(10_000) : new Decimal(0);
  const total = subtotal.add(taxTotal);

  void packageBasePrice;
  return {
    labor: round(labor),
    parts: round(parts),
    travel: round(travel),
    inspection: round(inspection),
    emergency: round(emergency),
    discount: round(discount),
    subtotal: round(subtotal),
    taxRate,
    taxTotal: round(taxTotal),
    total: round(total),
    currency: "IRR",
    pricingVersion: "rate-card-" + card.version,
    breakdown: {
      laborRate: fixedLabor,
      laborHours: 0,
      serviceCode,
      assetClass,
      includedDistanceKm: card.fees[assetClass].includedKm,
      travelRate: card.fees[assetClass].perKmIrr,
      travelDistanceKm: input.travelDistanceKm,
      emergencyMultiplier: 1 + card.emergencySurchargeBps / 10_000,
      vipDiscountPercent: 0,
    },
  };
}

// Create a pricing snapshot (frozen at booking time).
//
// The snapshot persists the breakdown as immutable `Decimal` columns on
// PricingSnapshot (see prisma/schema.prisma §PricingSnapshot). Prisma accepts
// either a `number`, a `string`, or a `Decimal` for Decimal columns — we pass
// `number` here for simplicity, since calculatePrice has already rounded to
// integer IRR.
export async function createPricingSnapshot(
  bookingId: string,
  pricing: PricingBreakdown
): Promise<string> {
  const db = await getDbForLib();
  const snapshot = await db.pricingSnapshot.create({
    data: {
      bookingId,
      servicePrice: pricing.labor, // labor as service price
      visitPrice: pricing.travel,
      inspectionPrice: pricing.inspection,
      emergencyPrice: pricing.emergency,
      financialUnitStatus: "VERIFIED_IRR",
      laborPrice: pricing.labor,
      partsPrice: pricing.parts,
      discount: pricing.discount,
      taxRate: pricing.taxRate,
      taxTotal: pricing.taxTotal,
      total: pricing.total,
      currency: pricing.currency,
      pricingVersion: pricing.pricingVersion,
    },
  });
  return snapshot.id;
}
