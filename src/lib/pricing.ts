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

export interface PricingInput {
  packageId?: string;
  vehicleType: string; // CAR, TRUCK, EXCAVATOR, etc.
  laborHours: number; // estimated hours
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
    travelRate: number;
    travelDistanceKm: number;
    emergencyMultiplier: number;
    vipDiscountPercent: number;
  };
}

const DEFAULT_TAX_RATE = 0.09; // 9% VAT
const EMERGENCY_MULTIPLIER = 1.5;

// Region multipliers (Tehran = 1.0 base). Reserved for future region-based
// pricing — currently not applied (see `void REGION_MULTIPLIERS` below).
const REGION_MULTIPLIERS: Record<string, number> = {
  tehran: 1.0,
  karaj: 0.95,
  isfahan: 0.9,
  shiraz: 0.9,
  mashhad: 0.9,
  tabriz: 0.88,
  other: 0.85,
};

// Vehicle type multipliers (heavy machinery costs more).
const VEHICLE_TYPE_MULTIPLIERS: Record<string, number> = {
  CAR: 1.0,
  TRUCK: 1.5,
  BUS: 1.4,
  EXCAVATOR: 2.0,
  LOADER: 2.0,
  BULLDOZER: 2.2,
  GRADER: 1.8,
  AGRI: 1.6,
  INDUSTRIAL: 1.8,
  OTHER: 1.3,
};

// IRR has no minor units — all money values are integers. Decimal.round()
// yields a Decimal that exactly represents the rounded integer; toNumber()
// then converts without precision loss.
function round(dec: Decimal): number {
  return dec.round().toNumber();
}

export async function calculatePrice(input: PricingInput): Promise<PricingBreakdown> {
    const db = await getDbForLib();
  // Get package base price if provided. Today the package base price is
  // informational — the primary price driver is vehicle-type-scaled labor +
  // parts + travel. Phase 5 will fold it into the calculation (e.g. as a
  // pre-paid service credit) once the package redemption flow lands. Keeping
  // the fetch preserves the async contract callers will depend on.
  let packageBasePrice = new Decimal(0);
  if (input.packageId) {
    const pkg = await db.servicePackage.findUnique({ where: { id: input.packageId } });
    if (pkg?.basePrice != null) {
      packageBasePrice = new Decimal(pkg.basePrice.toString());
    }
  }

  // ── Labor ───────────────────────────────────────────────────────────────
  // Labor rate depends on vehicle type (heavy machinery = higher rate).
  //   baseLaborRate = 50,000 IRR/hour
  //   laborRate    = baseLaborRate × vehicleMultiplier
  //   labor        = laborRate × laborHours
  const vehicleMultiplier = VEHICLE_TYPE_MULTIPLIERS[input.vehicleType] ?? 1.3;
  const baseLaborRate = new Decimal(50000);
  const laborRate = baseLaborRate.mul(vehicleMultiplier);
  const labor = laborRate.mul(input.laborHours);

  // ── Parts ───────────────────────────────────────────────────────────────
  const parts = new Decimal(input.partsCost);

  // ── Travel ─────────────────────────────────────────────────────────────
  //   baseTravelFee = 15,000 IRR (on-site visit fee)
  //   perKmRate     = 2,000 IRR/km
  //   travel        = baseTravelFee + perKmRate × travelDistanceKm
  const baseTravelFee = new Decimal(15000);
  const perKmRate = new Decimal(2000);
  const travel = baseTravelFee.add(perKmRate.mul(input.travelDistanceKm));

  // ── Emergency surcharge ─────────────────────────────────────────────────
  //   emergency = (labor + parts + travel) × (EMERGENCY_MULTIPLIER − 1)
  //            = preDiscount × 0.5   (when isEmergency=true)
  const preDiscount = labor.add(parts).add(travel);
  const emergency = input.isEmergency
    ? preDiscount.mul(EMERGENCY_MULTIPLIER - 1)
    : new Decimal(0);

  // ── Subtotal (before discount) ──────────────────────────────────────────
  //   subtotal = preDiscount + emergency
  // Note: `subtotal` in the returned object is the PRE-DISCOUNT subtotal.
  // The post-discount subtotal (= subtotal − discount) is implicit in
  // `total − taxTotal`.
  const subtotal = preDiscount.add(emergency);

  // ── Discount (VIP or promo) ─────────────────────────────────────────────
  //   discount = subtotal × vipPercent / 100
  const vipPercent = input.vipDiscountPercent ?? 0;
  const discount = subtotal.mul(vipPercent).div(100);

  // ── After-discount subtotal ─────────────────────────────────────────────
  const afterDiscount = subtotal.sub(discount);

  // ── Tax (9% VAT on the after-discount subtotal) ────────────────────────
  const taxTotal = afterDiscount.mul(DEFAULT_TAX_RATE);

  // ── Total = afterDiscount + taxTotal ────────────────────────────────────
  const total = afterDiscount.add(taxTotal);

  // Region multiplier is reserved for future region-based pricing — keep it
  // in the input contract so callers don't need to change shape when we
  // activate it. For now we don't apply it (Tehran base = 1.0 is the
  // implicit default above).
  void packageBasePrice;
  void REGION_MULTIPLIERS;
  void input.region;

  return {
    labor: round(labor),
    parts: round(parts),
    travel: round(travel),
    emergency: round(emergency),
    discount: round(discount),
    subtotal: round(subtotal),
    taxRate: DEFAULT_TAX_RATE,
    taxTotal: round(taxTotal),
    total: round(total),
    currency: "IRR",
    pricingVersion: "2.1", // Bumped for Decimal-safe arithmetic
    breakdown: {
      laborRate: laborRate.toNumber(),
      laborHours: input.laborHours,
      travelRate: perKmRate.toNumber(),
      travelDistanceKm: input.travelDistanceKm,
      emergencyMultiplier: input.isEmergency ? EMERGENCY_MULTIPLIER : 1,
      vipDiscountPercent: vipPercent,
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
