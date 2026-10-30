import { getDbForLib } from "@/lib/db-access";

export type ExchangeRateSnapshot = {
  rate: number;
  baseRate: number;
  multiplier: number;
  source: string;
  fetchedAt: number;
};

let cache: ExchangeRateSnapshot | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Returns the current USD → IRR rate from the same source used by the UI.
 * This server-side helper is also used when converting a USD-denominated
 * order into the Rial amount recorded by a gateway attempt.
 */
export async function getUsdToIrrRate(): Promise<ExchangeRateSnapshot> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const db = await getDbForLib();
  let rate: number | null = null;
  let source = "unknown";

  try {
    const [telegramSetting, sourceSetting] = await Promise.all([
      db.platformSetting.findUnique({ where: { key: "usd_irr_rate_telegram" } }),
      db.platformSetting.findUnique({ where: { key: "usd_irr_rate_source" } }),
    ]);
    if (telegramSetting?.value) {
      const candidate = Number(telegramSetting.value);
      if (Number.isFinite(candidate) && candidate >= 100_000) {
        rate = candidate;
        source = sourceSetting?.value || "telegram";
      }
    }
  } catch {
    // Continue to the public FX fallback.
  }

  if (!rate) {
    try {
      const response = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json() as { rates?: { IRR?: number } };
        const candidate = data?.rates?.IRR;
        if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
          rate = candidate;
          source = "open.er-api.com";
        }
      }
    } catch {
      // Use the configured fallback below.
    }
  }

  if (!rate) {
    rate = 6_000_000;
    source = "mekanix-internal";
  }

  let multiplier = 1;
  try {
    const setting = await db.platformSetting.findUnique({ where: { key: "usd_irr_multiplier" } });
    if (setting?.value) {
      const candidate = Number(setting.value);
      if (Number.isFinite(candidate) && candidate > 0) multiplier = candidate;
    }
  } catch {
    // Keep the neutral multiplier.
  }

  cache = {
    rate: Math.round(rate * multiplier),
    baseRate: rate,
    multiplier,
    source,
    fetchedAt: now,
  };
  return cache;
}

/** Test-only cache reset; safe to call from isolated unit tests. */
export function resetUsdToIrrRateCache(): void {
  cache = null;
}
