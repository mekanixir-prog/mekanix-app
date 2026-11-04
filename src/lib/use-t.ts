"use client";
import { useEffect } from "react";
import { useApp } from "./store";
import { translate, type Lang, LANGS } from "./i18n";
import { fmtMoney } from "./format";

// Returns the current language + a translation function.
// Also keeps <html dir> and lang attribute in sync for RTL/LTR.
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

  // Language controls number presentation only. It must never change the
  // currency declared by the underlying record or trigger an implicit FX path.
  const money = (amount: unknown, currency: string = "IRR") =>
    fmtMoney(amount, currency, lang);
  const isFa = lang === "fa";
  return {
    t,
    lang,
    isFa,
    dir: lang === "fa" ? ("rtl" as const) : ("ltr" as const),
    cat,
    type,
    notifType,
    money,
  };
}

export { LANGS, type Lang };
