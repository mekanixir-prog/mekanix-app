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
    { slug: "passenger" as MachineMode, icon: "Car", tone: "amber", types: ["CAR"] },
    { slug: "heavy" as MachineMode, icon: "Truck", tone: "emerald", types: ["TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL", "OTHER"] },
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
      <div className="relative z-20 flex items-center justify-between p-5" dir={isFa ? "rtl" : "ltr"}>
        <button onClick={exitToSplash} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          {isFa ? <LogOut className="size-4" /> : <ArrowRight className="size-4 rotate-180" />}
          {t("mode.signOut")}
        </button>
        <Logo size={28} />
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
      <div className="relative z-20 mx-auto max-w-5xl px-6 pt-6 text-center" dir={isFa ? "rtl" : "ltr"}>
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
          className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl"
        >
          {t("mode.title")}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mt-2 text-sm text-muted-foreground"
        >
          {t("mode.subtitle")}
        </motion.p>
      </div>

      {/* Two mode cards — side-by-side on ALL viewports (mobile + desktop)
          so both fit without scrolling. Card height matches the image's
          intrinsic aspect ratio (heavy cards are 2.5:1 → aspect-[5/2]). */}
      <div className="relative z-20 mx-auto grid max-w-5xl grid-cols-2 gap-3 px-4 py-4 sm:gap-5 sm:px-6 sm:py-6" dir={isFa ? "rtl" : "ltr"}>
        {modes.map((mode, i) => (
          <motion.button
            key={mode.slug}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.08, type: "spring", stiffness: 200 }}
            whileHover={{ y: -4 }}
            onClick={() => choose(mode.slug)}
            className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-card p-0 transition-colors mk-card-shadow mk-card-hover ${mode.tone === "amber" ? "border-amber/40 hover:border-amber" : "border-emerald-glow/40 hover:border-emerald-glow"}`}
          >
            <div className={`absolute -right-16 -top-16 size-48 rounded-full blur-3xl ${mode.tone === "amber" ? "bg-amber/20" : "bg-emerald-glow/15"}`} />

            {/* Card hero image — matches the image's intrinsic aspect ratio
                (heavy: 1983x793 ≈ 2.5:1, passenger: 1983x793 ≈ 2.5:1) so the
                card height tracks the image, not arbitrary padding. */}
            <div className="relative aspect-[5/2] w-full overflow-hidden">
              <img
                src={cardImage(mode.slug)}
                alt={mode.slug === "passenger" ? t("mode.passenger") : t("mode.heavy")}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                loading="lazy"
              />
              {/* Gradient overlay so the text overlaid on the image stays legible */}
              <div className="absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />
            </div>

            {/* Card meta — overlaid on the bottom of the image.
                Icon on the OPPOSITE side from the text:
                  - passenger card (amber, RTL): icon left, text right
                  - heavy card (emerald, RTL): icon right, text left
                We alternate via mode.slug so the two cards mirror each other. */}
            <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3 sm:p-4">
              {/* Text block */}
              <div className={`relative min-w-0 ${mode.slug === "heavy" ? "order-2 text-right" : "order-1 text-left"}`}>
                <h2 className="font-display text-sm font-bold tracking-tight text-foreground sm:text-lg">
                  {mode.slug === "passenger" ? t("mode.passenger") : t("mode.heavy")}
                </h2>
                <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground sm:text-xs">
                  {mode.slug === "passenger" ? t("mode.passengerDesc") : t("mode.heavyDesc")}
                </p>
              </div>
              {/* Icon chip — opposite side from the text */}
              <div className={`relative grid size-9 shrink-0 place-items-center rounded-xl border sm:size-12 ${mode.slug === "heavy" ? "order-1" : "order-2"} ${mode.tone === "amber" ? "border-amber/40 bg-amber/10" : "border-emerald-glow/40 bg-emerald-glow/10"}`}>
                <MekIcon name={mode.icon} className={`size-4 sm:size-6 ${mode.tone === "amber" ? "text-amber" : "text-emerald-glow"}`} />
              </div>
            </div>
          </motion.button>
        ))}
      </div>

      {/* Helper strip */}
      <div className="relative z-20 mx-auto max-w-5xl px-6 pb-8" dir={isFa ? "rtl" : "ltr"}>
        <div className="grid gap-2 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3">
          {[
            { icon: Wrench, label: t("mode.verifiedSpecialists"), desc: t("mode.backgroundChecked") },
            { icon: ShieldCheck, label: t("mode.warranty"), desc: t("mode.onPartsLabor") },
            { icon: Car, label: t("mode.onSiteService"), desc: t("mode.weComeToYou") },
          ].map((f, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="grid size-8 place-items-center rounded-lg border border-border bg-background">
                <f.icon className="size-4 text-amber" />
              </div>
              <div>
                <p className="text-xs font-medium">{f.label}</p>
                <p className="text-[10px] text-muted-foreground">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
        {auth.isGuest && (
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            {t("mode.guestBrowseHint")}
          </p>
        )}
      </div>
    </div>
  );
}
