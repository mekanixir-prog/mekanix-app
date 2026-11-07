import type { ServiceCode } from "@/lib/pricing-rate-card";

/** Resolve a persisted service category to an explicit fixed-fee rate-card code. */
export function serviceCodeFromCategory(category: string): ServiceCode | null {
  const value = category.toLowerCase();
  if (value.includes("hydraulic") || value.includes("هیدرولیک")) return "hydraulic";
  if (value.includes("elect") || value.includes("برق") || value.includes("سیم")) return "electrical";
  if (value.includes("cool") || value.includes("کولر") || value.includes("خنک") || value.includes("رادیات")) return "cooling";
  if (value.includes("brake") || value.includes("suspension") || value.includes("ترمز") || value.includes("تعلیق") || value.includes("جلوبندی")) return "brakes";
  if (value.includes("periodic") || value.includes("maintenance") || value.includes("سرویس") || value.includes("دوره")) return "periodic";
  if (value.includes("engine") || value.includes("motor") || value.includes("موتور")) {
    if (value.includes("major") || value.includes("اساسی") || value.includes("کامل")) return "engine_major";
    if (value.includes("minor") || value.includes("جزئی") || value.includes("سبک")) return "engine_minor";
    return null;
  }
  if (value.includes("transmission") || value.includes("gearbox") || value.includes("گیربکس") || value.includes("انتقال قدرت")) return "transmission";
  if (value.includes("undercarriage") || value.includes("chassis") || value.includes("زیربندی") || value.includes("شاسی")) return "undercarriage";
  if (value.includes("diagnos") || value.includes("diagnostic") || value.includes("عیب") || value.includes("دیاگ") || value.includes("تشخیص")) return "diagnostic";
  return null;
}

/** Approximate road distance from the earliest job-scoped dispatch tracking point. */
export function estimateTravelDistanceKm(
  from: { lat: number; lng: number },
  to: { lat: number | null; lng: number | null },
): number {
  if (to.lat === null || to.lng === null ||
      ![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) return 0;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  const straightLineKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  // This is a disclosed estimate, not a navigation-provider route.
  return Math.ceil(straightLineKm * 1.3);
}
