export const RATE_CARD_SETTING_KEY = "mekanix.pricing.rate-card.v1";
export const RATE_CARD_HISTORY_LIMIT = 20;

export const LABOR_CATEGORIES = [
  "diagnostics", "electrical", "cooling", "brakesSuspension", "periodic",
  "minorEngine", "majorEngine", "transmission", "hydraulics", "undercarriage",
] as const;
export type LaborCategory = typeof LABOR_CATEGORIES[number];
export type AssetClass = "passenger" | "heavy";

export type RateCardIrr = {
  currency: "IRR";
  displayUnit: "TOMAN";
  passenger: { dispatchIrr: number; inspectionIrr: number; includedDistanceKm: number; extraDistanceIrrPerKm: number; laborIrr: Partial<Record<LaborCategory, number>> };
  heavy: { dispatchIrr: number; inspectionIrr: number; includedDistanceKm: number; extraDistanceIrrPerKm: number; laborIrr: Partial<Record<LaborCategory, number>> };
  emergencyLaborSurchargePercent: number;
  maxManualDiscountPercent: 10;
  vip: { passengerAnnualIrr: number; heavyAnnualIrr: number; visitsPerYear: 4; saleEnabled: false };
  taxEnabled: false;
  platformCommissionEnabled: false;
};

export type RateCardTomanInput = {
  passenger: { dispatchToman: number; inspectionToman: number; includedDistanceKm: number; extraDistanceTomanPerKm: number; laborToman: Partial<Record<LaborCategory, number>> };
  heavy: { dispatchToman: number; inspectionToman: number; includedDistanceKm: number; extraDistanceTomanPerKm: number; laborToman: Partial<Record<LaborCategory, number>> };
  emergencyLaborSurchargePercent: number;
  vip: { passengerAnnualToman: number; heavyAnnualToman: number; visitsPerYear: 4 };
};

const passengerLabor = {
  diagnostics: 800_000, electrical: 1_200_000, cooling: 1_200_000,
  brakesSuspension: 1_500_000, periodic: 1_800_000, minorEngine: 2_500_000,
  majorEngine: 8_000_000, transmission: 6_000_000,
};
const heavyLabor = {
  diagnostics: 3_500_000, electrical: 3_000_000, cooling: 4_000_000,
  brakesSuspension: 5_000_000, periodic: 5_000_000, minorEngine: 6_000_000,
  majorEngine: 18_000_000, transmission: 12_000_000, hydraulics: 8_000_000,
  undercarriage: 9_000_000,
};
const toIrr = (toman: number) => toman * 10;

export function createDefaultRateCardIrr(): RateCardIrr {
  return {
    currency: "IRR", displayUnit: "TOMAN",
    passenger: {
      dispatchIrr: toIrr(500_000), inspectionIrr: toIrr(600_000),
      includedDistanceKm: 10, extraDistanceIrrPerKm: toIrr(10_000),
      laborIrr: Object.fromEntries(Object.entries(passengerLabor).map(([k, v]) => [k, toIrr(v)])),
    },
    heavy: {
      dispatchIrr: toIrr(2_000_000), inspectionIrr: toIrr(2_000_000),
      includedDistanceKm: 10, extraDistanceIrrPerKm: toIrr(30_000),
      laborIrr: Object.fromEntries(Object.entries(heavyLabor).map(([k, v]) => [k, toIrr(v)])),
    },
    emergencyLaborSurchargePercent: 30, maxManualDiscountPercent: 10,
    vip: { passengerAnnualIrr: toIrr(1_800_000), heavyAnnualIrr: toIrr(6_000_000), visitsPerYear: 4, saleEnabled: false },
    taxEnabled: false, platformCommissionEnabled: false,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function tomanToIrr(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(label + " must be a non-negative integer Toman amount");
  const result = BigInt(value) * BigInt(10);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(label + " exceeds safe integer IRR");
  return Number(result);
}
function distance(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 500) throw new TypeError(label + " must be an integer from 0 to 500");
  return value;
}
function percent(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 100) throw new TypeError(label + " must be an integer from 0 to 100");
  return value;
}

export function parseRateCardTomanInput(value: unknown): RateCardIrr {
  if (!object(value) || !object(value.passenger) || !object(value.heavy) || !object(value.vip)) throw new TypeError("Invalid rate card payload");
  const asset = (raw: Record<string, unknown>, name: string) => {
    if (!object(raw.laborToman)) throw new TypeError(name + ".laborToman is required");
    const requiredCategories: LaborCategory[] = name === "passenger"
      ? ["diagnostics", "electrical", "cooling", "brakesSuspension", "periodic", "minorEngine", "majorEngine", "transmission"]
      : [...LABOR_CATEGORIES];
    for (const category of requiredCategories) {
      if (raw.laborToman[category] === undefined) throw new TypeError(name + ".laborToman." + category + " is required");
    }
    const laborIrr: Partial<Record<LaborCategory, number>> = {};
    for (const [key, amount] of Object.entries(raw.laborToman)) {
      if (!LABOR_CATEGORIES.includes(key as LaborCategory)) throw new TypeError("Unsupported labor category: " + key);
      laborIrr[key as LaborCategory] = tomanToIrr(amount, name + ".laborToman." + key);
    }
    return {
      dispatchIrr: tomanToIrr(raw.dispatchToman, name + ".dispatchToman"),
      inspectionIrr: tomanToIrr(raw.inspectionToman, name + ".inspectionToman"),
      includedDistanceKm: distance(raw.includedDistanceKm, name + ".includedDistanceKm"),
      extraDistanceIrrPerKm: tomanToIrr(raw.extraDistanceTomanPerKm, name + ".extraDistanceTomanPerKm"),
      laborIrr,
    };
  };
  if (value.vip.visitsPerYear !== 4) throw new TypeError("VIP visitsPerYear is fixed at four");
  return {
    currency: "IRR", displayUnit: "TOMAN",
    passenger: asset(value.passenger, "passenger"),
    heavy: asset(value.heavy, "heavy"),
    emergencyLaborSurchargePercent: percent(value.emergencyLaborSurchargePercent, "emergencyLaborSurchargePercent"),
    maxManualDiscountPercent: 10,
    vip: {
      passengerAnnualIrr: tomanToIrr(value.vip.passengerAnnualToman, "vip.passengerAnnualToman"),
      heavyAnnualIrr: tomanToIrr(value.vip.heavyAnnualToman, "vip.heavyAnnualToman"),
      visitsPerYear: 4, saleEnabled: false,
    },
    taxEnabled: false, platformCommissionEnabled: false,
  };
}

function irrToToman(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value % 10 !== 0) throw new TypeError("Stored rate card contains an invalid IRR amount");
  return value / 10;
}
export function rateCardIrrToTomanInput(card: RateCardIrr): RateCardTomanInput {
  const asset = (raw: RateCardIrr["passenger"]) => ({
    dispatchToman: irrToToman(raw.dispatchIrr),
    inspectionToman: irrToToman(raw.inspectionIrr),
    includedDistanceKm: raw.includedDistanceKm,
    extraDistanceTomanPerKm: irrToToman(raw.extraDistanceIrrPerKm),
    laborToman: Object.fromEntries(Object.entries(raw.laborIrr).map(([k, v]) => [k, irrToToman(v as number)])),
  });
  return {
    passenger: asset(card.passenger), heavy: asset(card.heavy),
    emergencyLaborSurchargePercent: card.emergencyLaborSurchargePercent,
    vip: {
      passengerAnnualToman: irrToToman(card.vip.passengerAnnualIrr),
      heavyAnnualToman: irrToToman(card.vip.heavyAnnualIrr),
      visitsPerYear: 4,
    },
  };
}
export function isValidStoredRateCard(value: unknown): value is RateCardIrr {
  try {
    if (!object(value) || value.currency !== "IRR" || value.displayUnit !== "TOMAN" ||
      value.maxManualDiscountPercent !== 10 || value.taxEnabled !== false ||
      value.platformCommissionEnabled !== false || !object(value.vip) ||
      value.vip.visitsPerYear !== 4 || value.vip.saleEnabled !== false ||
      !Number.isSafeInteger(value.emergencyLaborSurchargePercent) ||
      Number(value.emergencyLaborSurchargePercent) < 0 || Number(value.emergencyLaborSurchargePercent) > 100) return false;
    const tomanInput = rateCardIrrToTomanInput(value as unknown as RateCardIrr);
    parseRateCardTomanInput(tomanInput);
    return true;
  } catch { return false; }
}
