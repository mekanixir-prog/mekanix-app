import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/exchange-rate
// Returns the current USD→IRR exchange rate.
// Public endpoint (no auth needed) — but cached for 60 seconds to limit upstream calls.
// Priority: Telegram bot rate (@NerkhDollarIRT) > official API > fallback
// Also applies admin-configured multiplier if set.

// In-memory cache (per-server / per-Workers-isolate)
let cache: { rate: number; baseRate: number; multiplier: number; source: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache, cached: true });
  }

  // Only obtain the DB client on a cache miss (avoids unnecessary async work
  // when the 60s cache is still valid).
  const db = await getDbForLib();

  // 1. Try Telegram rate (stored by mini-services/telegram-rate-bot)
  let rate: number | null = null;
  let source = "unknown";

  try {
    const telegramSetting = await db.platformSetting.findUnique({ where: { key: "usd_irr_rate_telegram" } });
    const sourceSetting = await db.platformSetting.findUnique({ where: { key: "usd_irr_rate_source" } });

    if (telegramSetting?.value) {
      rate = parseFloat(telegramSetting.value);
      source = sourceSetting?.value || "telegram";
    }
  } catch {}

  // 2. Fallback to official API if Telegram rate not available
  if (!rate || rate < 100000) {
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const irr = data?.rates?.IRR;
        if (typeof irr === "number" && irr > 0) {
          rate = irr;
          source = "open.er-api.com";
        }
      }
    } catch {}
  }

  // 3. Final fallback
  if (!rate) {
    rate = 6000000; // realistic Iranian free market rate
    source = "mekanix-internal";
  }

  // 4. Apply admin-configured multiplier (default 1.0)
  let multiplier = 1.0;
  try {
    const multSetting = await db.platformSetting.findUnique({ where: { key: "usd_irr_multiplier" } });
    if (multSetting?.value) {
      multiplier = parseFloat(multSetting.value);
    }
  } catch {}

  const finalRate = Math.round(rate * multiplier);

  cache = {
    rate: finalRate,
    baseRate: rate,
    multiplier,
    source,
    fetchedAt: now,
  };

  return NextResponse.json({
    rate: finalRate,
    baseRate: rate,
    multiplier,
    source,
    fetchedAt: now,
  });
}
