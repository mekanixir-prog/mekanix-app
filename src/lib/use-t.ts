"use client";
import { useEffect } from "react";
import { useApp } from "./store";
import { translate, type Lang, LANGS } from "./i18n";
import { fmtMoney, setUsdToIrrRate } from "./format";

// Returns the current language + a translation function.
// Also keeps <html dir> and lang attribute in sync for RTL/LTR.
// Fetches the live USD→IRR exchange rate on mount (refreshes every 5 min).
export function useT() {
  const lang = useApp((s) => s.lang);

  useEffect(() => {
    const dir = lang === "fa" ? "rtl" : "ltr";
    if (typeof document !== "undefined") {
      document.documentElement.dir = dir;
      document.documentElement.lang = lang;
    }
  }, [lang]);

  // Fetch live exchange rate (USD → IRR) — used by money() for Persian users.
  // The /api/exchange-rate endpoint tries free FX APIs first, falls back to
  // a simulated drifting rate if network fails. In production, wire this to
  // a Telegram bot that scrapes Iranian rate channels (TGJU, etc.).
  useEffect(() => {
    let cancelled = false;
    const fetchRate = async () => {
      try {
        const res = await fetch("/api/exchange-rate");
        const data = await res.json();
        if (!cancelled && typeof data?.rate === "number") {
          setUsdToIrrRate(data.rate);
        }
      } catch {
        // Silent — keep the default rate (6,000,000)
      }
    };
    fetchRate();
    const interval = setInterval(fetchRate, 5 * 60 * 1000); // refresh every 5 min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const t = (key: string, fallback?: string) => translate(lang, key, fallback);
  const cat = (slug: string) => translate(lang, `cat.${slug}`, slug);
  const type = (slug: string) => translate(lang, `type.${slug}`, slug);
  const notifType = (ntype: string) => translate(lang, `notif.type.${ntype}`, ntype);
  // Money helper: when language is Persian, force IRR conversion (Iran market).
  const money = (amount: number, currency: string = "IRR") =>
    fmtMoney(amount, lang === "fa" ? "IRR" : currency, lang);
  const isFa = lang === "fa";
  return { t, lang, isFa, dir: lang === "fa" ? ("rtl" as const) : ("ltr" as const), cat, type, notifType, money };
}

export { LANGS, type Lang };
