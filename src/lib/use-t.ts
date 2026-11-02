"use client";
import { useEffect } from "react";
import { useApp } from "./store";
import { translate, type Lang, LANGS } from "./i18n";
import { fmtMoney } from "./format";

// Returns the current language + a translation function. Keeps <html dir> and lang in sync.
export function useT() {
  const lang = useApp((s) => s.lang);

  useEffect(() => {
    const dir = lang === "fa" ? "rtl" : "ltr";
    if (typeof document !== "undefined") {
      document.documentElement.dir = dir;
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const t = (key: string, fallback?: string) => translate(lang, key, fallback);
  const cat = (slug: string) => translate(lang, `cat.${slug}`, slug);
  const type = (slug: string) => translate(lang, `type.${slug}`, slug);
  const notifType = (ntype: string) => translate(lang, `notif.type.${ntype}`, ntype);
  // Formatting follows the amount's declared currency; locale never changes its unit.
  const money = (amount: number, currency: string = "IRR") => fmtMoney(amount, currency, lang);
  const isFa = lang === "fa";
  return { t, lang, isFa, dir: lang === "fa" ? ("rtl" as const) : ("ltr" as const), cat, type, notifType, money };
}

export { LANGS, type Lang };
