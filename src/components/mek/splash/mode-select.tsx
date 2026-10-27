"use client";
import { motion } from "framer-motion";
import { ArrowRight, Car, Truck, Wrench, ShieldCheck, LogOut, Languages, Sun, Moon } from "lucide-react";
import { useApp } from "@/lib/store";
import { useT, LANGS, type Lang } from "@/lib/use-t";
import { MACHINE_MODES, type MachineMode } from "@/lib/constants";
import { MekIcon } from "@/components/mek/shared/icons";
import { Logo } from "@/components/mek/brand/logo";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/mek/theme-provider";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";

export function ModeSelect() {
  const { auth, setMachineMode, exitToSplash, lang, setLang } = useApp();
  const { t, isFa, type: typeLabel } = useT();
  const { theme, setTheme } = useTheme();

  const choose = (mode: MachineMode) => {
    setMachineMode(mode);
    useApp.setState({ bootStage: "app", portal: "customer", role: "CUSTOMER", view: "home", params: {}, history: [] });
    toast.success(mode === "heavy" ? t("mode.switchedHeavy") : t("mode.switchedPassenger"));
  };

  const modes = [
    // HEAVY mode is FIRST (brand priority). Both cards use amber tone
    // (#F58220) on the mode-select screen — the emerald green is only for
    // the in-app accent AFTER the user picks passenger mode. On the
    // selection screen both cards are brand orange so the user isn't
    // confused by two different colors before they've chosen.
    { slug: "heavy" as MachineMode, icon: "Truck", tone: "amber", types: ["TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL", "OTHER"] },
    { slug: "passenger" as MachineMode, icon: "Car", tone: "amber", types: ["CAR"] },
  ];

  // Resolve which card image to show per mode + current theme.
  // Cards exist as 4 variants: heavy-dark, heavy-light, passenger-dark, passenger-light.
  const isDark = theme === "dark";
  const cardImage = (slug: MachineMode) =>
    slug === "passenger"
      ? isDark ? "/cards/passenger-dark.png" : "/cards/passenger-light.png"
      : isDark ? "/cards/heavy-dark.png" : "/cards/heavy-light.png";

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="absolute inset-0 mk-grid-bg opacity-[0.22]" />
      <div className="absolute left-1/2 top-1/2 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber/[0.06] blur-[140px]" />

      {/* Top bar */}
      <div className="relative z-20 flex items-center justify-between p-4 sm:p-5" dir={isFa ? "rtl" : "ltr"}>
        <button onClick={exitToSplash} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          {isFa ? <LogOut className="size-4" /> : <ArrowRight className="size-4 rotate-180" />}
          {t("mode.signOut")}
        </button>
        <Logo size={36} />
        <div className="flex items-center gap-2">
          {/* Day/Night theme toggle — applies to mode-select + persisted globally */}
          <button
            onClick={() => setTheme(isDark ? "light" : "dark")}
            aria-label={isDark ? "Switch to light" : "Switch to dark"}
            className="grid size-8 place-items-center rounded-lg border border-border bg-card/60 text-muted-foreground transition-colors hover:text-foreground"
          >
            {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {/* Language toggle */}
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-card/60 p-0.5">
            {LANGS.map((l) => (
              <button
                key={l.code}
                onClick={() => setLang(l.code as Lang)}
                className={`relative rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${lang === l.code ? "text-black" : "text-muted-foreground hover:text-foreground"}`}
              >
                {lang === l.code && <motion.div layoutId="mode-lang-pill" className="absolute inset-0 rounded-md bg-amber" transition={{ type: "spring", stiffness: 350, damping: 30 }} />}
                <span className="relative">{l.label}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <div className="grid size-7 place-items-center overflow-hidden rounded-full border border-border bg-muted">
              {auth.name ? <span className="text-[10px] font-medium">{auth.name[0]}</span> : <ShieldCheck className="size-3.5" />}
            </div>
          </div>
        </div>
      </div>

      {/* Heading */}
      <div className="relative z-20 mx-auto max-w-4xl px-4 pt-4 text-center sm:px-6 sm:pt-6" dir={isFa ? "rtl" : "ltr"}>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber"
        >
          {auth.isGuest ? t("mode.guest") : t("mode.greeting")}
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mt-2 font-display text-2xl font-bold tracking-tight sm:text-3xl"
        >
          {t("mode.title")}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mt-1 text-xs text-muted-foreground sm:text-sm"
        >
          {t("mode.subtitle")}
        </motion.p>
      </div>

      {/* Two mode cards — compact so both fit on mobile without scroll.
          Fixed compact aspect ratio (16/5) shorter than natural image ratio. */}
      <div className="relative z-20 mx-auto flex w-full max-w-4xl flex-col gap-2 px-3 pt-3 sm:gap-3 sm:px-6 sm:pt-4" dir={isFa ? "rtl" : "ltr"}>
        {modes.map((mode, i) => (
          <motion.button
            key={mode.slug}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.08, type: "spring", stiffness: 200 }}
            whileHover={{ y: -4 }}
            onClick={() => choose(mode.slug)}
            className="group relative block w-full overflow-hidden rounded-2xl border bg-card p-0 transition-colors mk-card-shadow mk-card-hover border-amber/40 hover:border-amber"
          >
            <div className="absolute -right-16 -top-16 size-48 rounded-full blur-3xl bg-amber/20" />

            {/* Card hero image — compact aspect ratio (16/5) so both cards
                fit on mobile without scroll. object-cover centers vehicle. */}
            <div
              className="relative w-full overflow-hidden"
              style={{ aspectRatio: "16 / 5" }}
            >
              <img
                key={cardImage(mode.slug)}
                src={cardImage(mode.slug)}
                alt={mode.slug === "passenger" ? t("mode.passenger") : t("mode.heavy")}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="eager"
              />
            </div>

            {/* Card meta — BELOW the image (not overlaid on it).
                Icon on the OPPOSITE side from the text:
                  - heavy card (amber, RTL): icon right, text left
                  - passenger card (amber, RTL): icon left, text right
                We alternate via mode.slug so the two cards mirror each other. */}
            <div className="relative flex items-center justify-between gap-2 p-2 sm:gap-3 sm:p-4">
              {/* Text block */}
              <div className={`relative min-w-0 ${mode.slug === "heavy" ? "order-2 text-right" : "order-1 text-left"}`}>
                <h2 className="font-display text-lg font-bold tracking-tight text-foreground sm:text-2xl">
                  {mode.slug === "passenger" ? t("mode.passenger") : t("mode.heavy")}
                </h2>
                <p className="mt-1 line-clamp-1 text-xs text-muted-foreground sm:text-sm">
                  {mode.slug === "passenger" ? t("mode.passengerDesc") : t("mode.heavyDesc")}
                </p>
              </div>
              {/* Icon chip — opposite side from the text */}
              <div className={`relative grid size-9 shrink-0 place-items-center rounded-lg border sm:size-12 sm:rounded-xl border-amber/40 bg-amber/10 ${mode.slug === "heavy" ? "order-1" : "order-2"}`}>
                <MekIcon name={mode.icon} className="size-4 sm:size-6 text-amber" />
              </div>
            </div>
          </motion.button>
        ))}
      </div>

      {/* Helper strip — compact */}
      <div className="relative z-20 mx-auto w-full max-w-4xl px-3 pb-3 sm:px-6 sm:pb-4" dir={isFa ? "rtl" : "ltr"}>
        <div className="grid grid-cols-3 gap-1.5 sm:gap-3">
          {[
            { icon: Wrench, label: t("mode.verifiedSpecialists"), desc: t("mode.backgroundChecked") },
            { icon: ShieldCheck, label: t("mode.warranty"), desc: t("mode.onPartsLabor") },
            { icon: Car, label: t("mode.onSiteService"), desc: t("mode.weComeToYou") },
          ].map((f, i) => (
            <div
              key={i}
              className="group/item flex flex-col items-center gap-1.5 rounded-xl border border-amber/20 bg-card/80 p-2 text-center mk-card-shadow transition-all hover:border-amber/40 hover:bg-amber/5 sm:flex-row sm:items-center sm:gap-2 sm:p-3 sm:text-left"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber/10 ring-1 ring-amber/30 sm:size-9">
                <f.icon className="size-4 text-amber sm:size-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-semibold text-foreground sm:text-xs">{f.label}</p>
                <p className="hidden text-[10px] text-muted-foreground sm:block sm:text-[11px]">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
        {auth.isGuest && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            {t("mode.guestBrowseHint")}
          </p>
        )}
      </div>
    </div>
  );
}
