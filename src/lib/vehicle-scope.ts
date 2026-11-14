/**
 * MEKANIX supports foreign passenger vehicles and the explicitly priced
 * heavy-equipment classes only. Iran Khodro, Saipa and Pars Khodro passenger
 * vehicles are excluded. Generic OTHER/unknown types fail closed because
 * they have no approved rate-card class.
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

const SUPPORTED_HEAVY_TYPES = new Set([
  "TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL",
]);

export function isVehicleInSupportedScope(type: unknown, make: unknown): boolean {
  if (type === "CAR") return !isExcludedPassengerMake(make);
  return typeof type === "string" && SUPPORTED_HEAVY_TYPES.has(type);
}
