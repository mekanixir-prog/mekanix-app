/**
 * Passenger-vehicle scope agreed for MEKANIX:
 * exclude Iran Khodro, Saipa and Pars Khodro; keep other importers/assemblers
 * such as Kerman Motor, Modiran Khodro and Farda Motor.
 *
 * Heavy equipment is not affected by this passenger-only restriction.
 */
function normalizeMakeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200c\u200f]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLocaleLowerCase("fa")
    .replace(/[\s\-_().]/g, "");
}

const EXCLUDED_PASSENGER_MAKE_KEYS = new Set([
  "ایرانخودرو",
  "گروهایرانخودرو",
  "irankhodro",
  "irankhodroikco",
  "ikco",
  "سایپا",
  "گروهسایپا",
  "saipa",
  "پارسخودرو",
  "parskhodro",
  "گروهسایپا(پارسخودرو)",
]);

export function isExcludedPassengerMake(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const key = normalizeMakeKey(value);
  if (EXCLUDED_PASSENGER_MAKE_KEYS.has(key)) return true;
  return key.includes("گروهایرانخودرو") || key.includes("گروهسایپا") ||
    key.startsWith("irankhodro") || key.startsWith("saipa") || key.startsWith("parskhodro");
}

export function isVehicleInSupportedScope(type: unknown, make: unknown): boolean {
  if (type !== "CAR") return true;
  return !isExcludedPassengerMake(make);
}
