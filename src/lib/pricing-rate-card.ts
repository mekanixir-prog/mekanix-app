import { getDbForLib } from "@/lib/db-access";
import { assertIrrInteger } from "@/lib/money/irr";

export const PRICING_RATE_CARD_KEY = "mekanix.pricing.rate-card.v1";
export type AssetClass = "passenger" | "heavy";
export type ServiceCode = "diagnostic" | "electrical" | "cooling" | "brakes" | "periodic" | "engine_minor" | "engine_major" | "transmission" | "hydraulic" | "undercarriage";
export interface PricingRateCard {
  schemaVersion: 1; version: number; currency: "IRR"; displayCurrency: "TOMAN";
  effectiveAt: string; updatedAt: string; updatedBy: string;
  fees: Record<AssetClass, { visitBaseIrr: number; inspectionIrr: number; includedKm: number; perKmIrr: number }>;
  serviceFeesIrr: Record<AssetClass, Record<ServiceCode, number | null>>;
  emergencySurchargeBps: number;
  tax: { enabled: boolean; rateBps: number };
  commission: { enabled: boolean; rateBps: number; appliesTo: "LABOR_ONLY" | "LABOR_AND_VISIT" | "INVOICE_SUBTOTAL" };
  vip: { enabled: boolean; annualPassengerPriceIrr: number; annualHeavyPriceIrr: number; freePeriodicVisitsPerYear: number; coversVisitAndInspection: boolean; excludesRepairsAndParts: true };
  discounts: { maxManualDiscountBps: number };
}
const passenger: Record<ServiceCode, number | null> = {
  diagnostic: 8_000_000, electrical: 12_000_000, cooling: 12_000_000, brakes: 15_000_000,
  periodic: 18_000_000, engine_minor: 25_000_000, engine_major: 80_000_000,
  transmission: 60_000_000, hydraulic: null, undercarriage: null,
};
const heavy: Record<ServiceCode, number | null> = {
  diagnostic: 35_000_000, electrical: 30_000_000, cooling: 40_000_000, brakes: 50_000_000,
  periodic: 50_000_000, engine_minor: 60_000_000, engine_major: 180_000_000,
  transmission: 120_000_000, hydraulic: 80_000_000, undercarriage: 90_000_000,
};
export const DEFAULT_PRICING_RATE_CARD: PricingRateCard = {
  schemaVersion: 1, version: 1, currency: "IRR", displayCurrency: "TOMAN",
  effectiveAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z", updatedBy: "MEKANIX_DEFAULT_RATE_CARD",
  fees: {
    passenger: { visitBaseIrr: 5_000_000, inspectionIrr: 6_000_000, includedKm: 10, perKmIrr: 100_000 },
    heavy: { visitBaseIrr: 20_000_000, inspectionIrr: 20_000_000, includedKm: 10, perKmIrr: 300_000 },
  },
  serviceFeesIrr: { passenger, heavy }, emergencySurchargeBps: 3000,
  tax: { enabled: false, rateBps: 0 },
  commission: { enabled: false, rateBps: 0, appliesTo: "LABOR_ONLY" },
  vip: { enabled: false, annualPassengerPriceIrr: 18_000_000, annualHeavyPriceIrr: 60_000_000, freePeriodicVisitsPerYear: 4, coversVisitAndInspection: true, excludesRepairsAndParts: true },
  discounts: { maxManualDiscountBps: 1000 },
};
function isRecord(v: unknown): v is Record<string, unknown> { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
function irr(v: unknown, name: string): number { assertIrrInteger(v, name); return v; }
function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(name + " must be an integer in range");
  return v;
}
export function validatePricingRateCard(value: unknown): Omit<PricingRateCard, "schemaVersion" | "version" | "currency" | "displayCurrency" | "effectiveAt" | "updatedAt" | "updatedBy"> {
  if (!isRecord(value) || !isRecord(value.fees) || !isRecord(value.serviceFeesIrr) || !isRecord(value.tax) || !isRecord(value.commission) || !isRecord(value.vip) || !isRecord(value.discounts)) throw new TypeError("ساختار نرخ‌نامه نامعتبر است");
  const codes: ServiceCode[] = ["diagnostic","electrical","cooling","brakes","periodic","engine_minor","engine_major","transmission","hydraulic","undercarriage"];
  const fees = {} as PricingRateCard["fees"];
  const serviceFeesIrr = {} as PricingRateCard["serviceFeesIrr"];
  for (const asset of ["passenger","heavy"] as const) {
    const f = value.fees[asset]; const s = value.serviceFeesIrr[asset];
    if (!isRecord(f) || !isRecord(s)) throw new TypeError("ساختار گروه نرخ نامعتبر است");
    fees[asset] = {
      visitBaseIrr: irr(f.visitBaseIrr, asset + ".visitBaseIrr"),
      inspectionIrr: irr(f.inspectionIrr, asset + ".inspectionIrr"),
      includedKm: int(f.includedKm, asset + ".includedKm", 0, 500),
      perKmIrr: irr(f.perKmIrr, asset + ".perKmIrr"),
    };
    const items = {} as Record<ServiceCode, number | null>;
    for (const code of codes) items[code] = s[code] === null ? null : irr(s[code], asset + "." + code);
    serviceFeesIrr[asset] = items;
  }
  if (typeof value.tax.enabled !== "boolean" || typeof value.commission.enabled !== "boolean" || typeof value.vip.enabled !== "boolean") throw new TypeError("وضعیت سیاست مالی نامعتبر است");
  const appliesTo = value.commission.appliesTo;
  if (appliesTo !== "LABOR_ONLY" && appliesTo !== "LABOR_AND_VISIT" && appliesTo !== "INVOICE_SUBTOTAL") throw new TypeError("پایه کمیسیون نامعتبر است");
  if (value.vip.coversVisitAndInspection !== true || value.vip.excludesRepairsAndParts !== true) throw new TypeError("مزایای VIP باید محدود به بازدید دوره‌ای باشد");
  return {
    fees, serviceFeesIrr,
    emergencySurchargeBps: int(value.emergencySurchargeBps, "emergencySurchargeBps", 0, 10000),
    tax: { enabled: value.tax.enabled, rateBps: int(value.tax.rateBps, "tax.rateBps", 0, 10000) },
    commission: { enabled: value.commission.enabled, rateBps: int(value.commission.rateBps, "commission.rateBps", 0, 5000), appliesTo },
    vip: {
      enabled: value.vip.enabled, annualPassengerPriceIrr: irr(value.vip.annualPassengerPriceIrr, "vip.annualPassengerPriceIrr"),
      annualHeavyPriceIrr: irr(value.vip.annualHeavyPriceIrr, "vip.annualHeavyPriceIrr"),
      freePeriodicVisitsPerYear: int(value.vip.freePeriodicVisitsPerYear, "vip.freePeriodicVisitsPerYear", 0, 24),
      coversVisitAndInspection: true, excludesRepairsAndParts: true,
    },
    discounts: { maxManualDiscountBps: int(value.discounts.maxManualDiscountBps, "discounts.maxManualDiscountBps", 0, 5000) },
  };
}
export function normalizeVehicleAssetClass(vehicleType: string): AssetClass { return vehicleType === "CAR" ? "passenger" : "heavy"; }
export async function getPricingRateCard(): Promise<PricingRateCard> {
  const db = await getDbForLib();
  const row = await db.platformSetting.findUnique({ where: { key: PRICING_RATE_CARD_KEY } });
  if (!row) return DEFAULT_PRICING_RATE_CARD;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { throw new Error("نرخ‌نامه ذخیره‌شده خراب است؛ محاسبه قیمت متوقف شد"); }
  if (!isRecord(parsed) || !isRecord(parsed.current)) throw new Error("ساختار نرخ‌نامه ذخیره‌شده نامعتبر است");
  const current = parsed.current;
  const clean = validatePricingRateCard(current);
  return {
    ...clean, schemaVersion: 1, version: int(current.version, "version", 1, 1_000_000),
    currency: "IRR", displayCurrency: "TOMAN",
    effectiveAt: typeof current.effectiveAt === "string" ? current.effectiveAt : "",
    updatedAt: typeof current.updatedAt === "string" ? current.updatedAt : "",
    updatedBy: typeof current.updatedBy === "string" ? current.updatedBy : "",
  };
}
