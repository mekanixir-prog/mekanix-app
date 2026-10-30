// MEKANIX — formatting & utility helpers
import { CURRENCIES } from "./constants";

// USD → IRR conversion rate. Default fallback matches the server's 6,000,000 IRR/USD fallback.
// On the client, `useT()` triggers a fetch from /api/exchange-rate which updates
// this live. In production, that endpoint scrapes Telegram rate channels or
// calls a free FX API.
let USD_TO_IRR = 6_000_000;

export function setUsdToIrrRate(rate: number) {
  if (typeof rate === "number" && rate > 0) {
    USD_TO_IRR = rate;
  }
}

export function getUsdToIrrRate(): number {
  return USD_TO_IRR;
}

// Convert digits to Persian
function toPersianDigits(s: string | number): string {
  const map = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  return String(s).replace(/\d/g, (d) => map[Number(d)]);
}

export function fmtMoney(amount: number, currency = "IRR", lang: "en" | "fa" = "en"): string {
  const c = CURRENCIES[currency] ?? CURRENCIES.USD;
  let converted = amount || 0;
  let symbol = c.symbol;

  // Convert USD base to IRR
  if (currency === "IRR") {
    converted = converted * USD_TO_IRR;
    symbol = "﷼";
  }

  // Format with proper grouping
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: currency === "IRR" ? 0 : 2,
  }).format(converted);

  // For Persian: convert digits to Persian + use ، (Persian comma) as thousands separator
  if (lang === "fa") {
    const persianFormatted = toPersianDigits(formatted.replace(/,/g, "،"));
    return `${symbol}${persianFormatted}`;
  }

  return `${symbol}${formatted}`;
}

export function fmtNumber(n: number, lang: "en" | "fa" = "en"): string {
  if (lang === "fa") return toPersianDigits(n);
  return String(n);
}

export { toPersianDigits };

export function fmtDistance(km: number, lang: "en" | "fa" = "en"): string {
  if (lang === "fa") {
    if (km < 1) return toPersianDigits(`${Math.round(km * 1000)} متر`);
    return `${toPersianDigits(km.toFixed(1))} کیلومتر`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function fmtDuration(mins: number, lang: "en" | "fa" = "en"): string {
  if (lang === "fa") {
    if (mins < 60) return `${toPersianDigits(Math.round(mins))} دقیقه`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m === 0 ? `${toPersianDigits(h)} ساعت` : `${toPersianDigits(h)} ساعت ${toPersianDigits(m)} دقیقه`;
  }
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function fmtRelative(date: Date | string | number, lang: "en" | "fa" = "en"): string {
  const d = typeof date === "object" ? date : new Date(date);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (lang === "fa") {
    if (diff < 60) return "همین الان";
    if (diff < 3600) return `${toPersianDigits(Math.floor(diff / 60))} دقیقه پیش`;
    if (diff < 86400) return `${toPersianDigits(Math.floor(diff / 3600))} ساعت پیش`;
    if (diff < 604800) return `${toPersianDigits(Math.floor(diff / 86400))} روز پیش`;
    return d.toLocaleDateString("fa-IR");
  }
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function fmtDate(date: Date | string | number, opts?: Intl.DateTimeFormatOptions, lang: "en" | "fa" = "en"): string {
  const d = typeof date === "object" ? date : new Date(date);
  if (lang === "fa") {
    return d.toLocaleDateString("fa-IR", opts ?? { month: "long", day: "numeric", year: "numeric" });
  }
  return d.toLocaleDateString("en-US", opts ?? { month: "short", day: "numeric", year: "numeric" });
}

export function fmtTime(date: Date | string | number, lang: "en" | "fa" = "en"): string {
  const d = typeof date === "object" ? date : new Date(date);
  if (lang === "fa") {
    return d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(date: Date | string | number, lang: "en" | "fa" = "en"): string {
  return `${fmtDate(date, undefined, lang)} · ${fmtTime(date, lang)}`;
}

// Haversine distance in km
export function haversine(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function genCode(prefix: string): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${n}${Math.floor(Math.random() * 9)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function pct(n: number, total: number): number {
  if (!total) return 0;
  return Math.round((n / total) * 100);
}

export function parseMedia(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
