"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone, Loader2, ShieldCheck, ChevronRight, Wrench, ArrowRight, ArrowLeft,
  KeyRound, UserRound, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApp } from "@/lib/store";
import { useT, LANGS, type Lang } from "@/lib/use-t";
import { COUNTRIES } from "@/lib/constants";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { MechanicApplicationForm } from "./mechanic-application";
import { toPersianDigits } from "@/lib/format";

type Stage = "entry" | "phone" | "otp";

export function Splash() {
  const { enterApp, lang, setLang } = useApp();
  const { t, isFa } = useT();
  const [stage, setStage] = useState<Stage>("entry");
  const [dial, setDial] = useState("+98");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentCode, setSentCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  const fullPhone = `${dial}${phone.replace(/\D/g, "")}`;

  const sendOtp = async () => {
    if (phone.replace(/\D/g, "").length < 9) {
      toast.error(t("splash.validPhone"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSentCode(data.code);
      setStage("otp");
      toast.success(t("splash.codeSent") + (data.code ? ` · ${isFa ? toPersianDigits(data.code) : data.code}` : ""));
    } catch (e: any) {
      toast.error(e.message ?? "Failed to send code");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (code.length < 6) {
      toast.error(t("splash.enterCodeShort"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Cookie is set automatically by server as HttpOnly.
      // No need to read token from response — the browser sends the cookie automatically.
      // (WebSocket auth will use a separate short-lived token from /api/auth/ws-token)
      toast.success(`${t("splash.welcome")}${data.user?.name ? "، " + data.user.name.split(" ")[0] + "!" : "!"}`);

      // If logging in as mechanic, check that the user has a technician profile
      if (loginTarget === "mechanic") {
        if (!data.user.technician) {
          toast.error(t("splash.notRegisteredMechanic"));
          setLoginTarget("customer");
          setStage("entry");
          return;
        }
        enterApp("mechanic", {
          userId: data.user.id,
          phone: fullPhone,
          name: data.user.name,
          isGuest: false,
          verified: true,
        });
      } else {
        enterApp("customer", {
          userId: data.user.id,
          phone: fullPhone,
          name: data.user.name,
          isGuest: false,
          verified: true,
        });
      }
    } catch (e: any) {
      toast.error(e.message ?? t("splash.invalidCode"));
    } finally {
      setBusy(false);
    }
  };

  const continueAsGuest = () => {
    enterApp("customer", { isGuest: true, verified: false, phone: null, name: "Guest", userId: null });
  };

  // Track if this login is for the mechanic portal
  const [loginTarget, setLoginTarget] = useState<"customer" | "mechanic">("customer");

  // Listen for "go to mechanic login" event from application form
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setLoginTarget("mechanic");
      if (detail?.phone) {
        const num = detail.phone.replace(/\D/g, "");
        setPhone(num.length > 10 ? num.slice(-10) : num);
      }
      setStage("phone");
    };
    window.addEventListener("mekanix-go-mechanic-login", handler);
    return () => window.removeEventListener("mekanix-go-mechanic-login", handler);
  }, []);



  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050607] flex flex-col">
      {/* Single ambient glow — soft, centered */}
      <div className="absolute left-1/2 top-[40%] size-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: "radial-gradient(circle, oklch(0.74 0.16 68 / 0.06), transparent 70%)" }} />

      {/* Language toggle — top corner, ultra-minimal */}
      <div className="absolute end-6 top-6 z-30 flex items-center gap-0.5 rounded-full border border-white/8 bg-white/5 p-0.5 backdrop-blur-sm">
        {LANGS.map((l) => (
          <button
            key={l.code}
            onClick={() => setLang(l.code as Lang)}
            className={`relative rounded-full px-3 py-1 text-[10px] font-medium transition-colors ${lang === l.code ? "text-black" : "text-white/40 hover:text-white/70"}`}
          >
            {lang === l.code && <motion.div layoutId="splash-lang" className="absolute inset-0 rounded-full bg-amber" transition={{ type: "spring", stiffness: 350, damping: 30 }} />}
            <span className="relative">{l.label}</span>
          </button>
        ))}
      </div>

      {/* Main content — vertically centered, spacious */}
      <div className="relative z-20 flex flex-1 flex-col items-center justify-center px-8">
        <AnimatePresence mode="wait">
          {stage === "entry" && (
            <motion.div
              key="entry"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full max-w-xs text-center"
            >
              {/* Logo — clean, inverted, well-sized */}
              <HeroLogo />

              {/* Primary actions — generous spacing */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.6 }}
                className="mt-12 space-y-3"
              >
                <Button onClick={() => { setLoginTarget("customer"); setStage("phone"); }} className="h-13 w-full rounded-xl bg-amber py-3.5 text-sm font-semibold text-black hover:bg-amber/90">
                  <Phone className="mr-2 size-4" /> {t("splash.signInMobile")}
                </Button>
                <Button onClick={continueAsGuest} variant="ghost" className="w-full rounded-xl py-3 text-sm text-white/60 hover:bg-white/5 hover:text-white">
                  <UserRound className="mr-2 size-4" /> {t("splash.continueGuest")}
                </Button>
              </motion.div>

              {/* Divider */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8 }}
                className="my-6 flex items-center gap-3"
              >
                <div className="h-px flex-1 bg-white/6" />
                <span className="text-[9px] tracking-widest text-white/20">{isFa ? "یا" : "OR"}</span>
                <div className="h-px flex-1 bg-white/6" />
              </motion.div>

              {/* Mechanic actions — clearly separated */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.9 }}
                className="space-y-2.5"
              >
                <button
                  onClick={() => { setLoginTarget("mechanic"); setStage("phone"); }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/8 py-3 text-sm text-white/50 transition-all hover:border-amber/30 hover:text-amber"
                >
                  <Wrench className="size-4" /> {t("splash.mechanicPortal")}
                </button>
                <button
                  onClick={() => setApplyOpen(true)}
                  className="block w-full text-center text-[11px] text-white/30 transition-colors hover:text-amber"
                >
                  {t("splash.applyMechanic")}
                </button>
              </motion.div>
            </motion.div>
          )}

          {stage === "phone" && (
            <motion.div
              key="phone"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="w-full"
              dir={isFa ? "rtl" : "ltr"}
            >
              <BackBtn onClick={() => setStage("entry")} label={t("splash.back")} />
              <div className="mt-2 text-center">
                <h2 className="font-display text-2xl font-semibold">
                  {loginTarget === "mechanic" ? t("splash.mechanicLogin") : t("splash.signIn")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {loginTarget === "mechanic" ? t("splash.mechanicLoginDesc") : t("splash.enterMobile")}
                </p>
              </div>

              <div className="mt-6 space-y-3">
                <div>
                  <Label className="text-xs">{t("splash.mobileNumber")}</Label>
                  <div className="mt-1.5 flex gap-2">
                    <Select value={dial} onValueChange={setDial}>
                      <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.dial}>{c.dial} {c.code}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="912 345 6789"
                      inputMode="tel"
                      className="flex-1"
                      autoFocus
                    />
                  </div>
                </div>
                <Button onClick={sendOtp} disabled={busy} className="h-11 w-full bg-amber text-black hover:bg-amber/90">
                  {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ChevronRight className={isFa ? "mr-2 size-4 rotate-180" : "mr-2 size-4"} />}
                  {t("splash.sendCode")}
                </Button>
              </div>
            </motion.div>
          )}

          {stage === "otp" && (
            <motion.div
              key="otp"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="w-full"
              dir={isFa ? "rtl" : "ltr"}
            >
              <BackBtn onClick={() => setStage("phone")} label={t("splash.back")} />
              <div className="mt-2 text-center">
                <div className="mx-auto grid size-12 place-items-center rounded-xl border border-amber/30 bg-amber/10">
                  <KeyRound className="size-5 text-amber" />
                </div>
                <h2 className="mt-4 font-display text-2xl font-semibold">{t("splash.enterCode")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("splash.sentTo")} <span className="font-medium text-foreground">{fullPhone}</span>
                </p>
                {sentCode && (
                  <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber/30 bg-amber/10 px-2.5 py-0.5 text-[11px] text-amber">
                    <Sparkles className="size-3" /> {t("splash.demoCode")}: {isFa ? toPersianDigits(sentCode) : sentCode}
                  </div>
                )}
              </div>

              <div className="mt-6 space-y-3">
                <OtpInput value={code} onChange={setCode} length={6} />
                <Button onClick={verifyOtp} disabled={busy || code.length < 6} className="h-11 w-full bg-amber text-black hover:bg-amber/90">
                  {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                  {t("splash.verifyContinue")}
                </Button>
                <button onClick={sendOtp} className="w-full text-center text-[11px] text-muted-foreground hover:text-amber">
                  {t("splash.resend")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <div className="mt-10 flex items-center gap-2 text-[10px] text-muted-foreground" dir={isFa ? "rtl" : "ltr"}>
          <ShieldCheck className="size-3 text-emerald-glow" />
          {t("splash.securedBy")}
        </div>
      </div>

      <MechanicApplicationForm open={applyOpen} onOpenChange={setApplyOpen} />
    </div>
  );
}

// ─── Hero logo: 2D brand mark (the original, before 3D) ───
// logo.webp is a black-on-white combination mark (M icon + "MEKANIX" wordmark
// + "REPAIR / MAINTAIN / CONNECT" tagline). On the dark splash we invert it
// via CSS so it reads as white-on-dark.
function HeroLogo() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
      className="relative mx-auto grid place-items-center"
      style={{ width: 240, height: 220 }}
    >
      {/* Subtle amber ambient glow behind the mark */}
      <div
        className="pointer-events-none absolute rounded-full"
        style={{
          width: 220, height: 220,
          background: "radial-gradient(circle, oklch(0.74 0.16 68 / 0.15), transparent 65%)",
        }}
      />

      {/* 2D Logo — the original brand mark, inverted for dark background */}
      <motion.img
        src="/logo.webp"
        alt="MEKANIX"
        className="relative z-10 select-none object-contain"
        style={{ width: 200, height: "auto", filter: "invert(1) hue-rotate(180deg) brightness(1.1)" }}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.6 }}
      />
    </motion.div>
  );
}

function BackBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="size-4" /> {label}
    </button>
  );
}

function OtpInput({ value, onChange, length }: { value: string; onChange: (v: string) => void; length: number }) {
  const cells = Array.from({ length });
  return (
    <div className="flex justify-center gap-2">
      {cells.map((_, i) => (
        <input
          key={i}
          value={value[i] ?? ""}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            const next = (value.slice(0, i) + v + value.slice(i + 1)).slice(0, length);
            onChange(next);
            if (v && i < length - 1) {
              const el = (e.target as HTMLElement).parentElement?.children[i + 1] as HTMLElement;
              el?.focus();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !value[i] && i > 0) {
              const el = (e.target as HTMLElement).parentElement?.children[i - 1] as HTMLElement;
              el?.focus();
            }
          }}
          inputMode="numeric"
          maxLength={1}
          className="size-12 rounded-xl border border-white/10 bg-white/5 text-center font-display text-xl font-semibold text-white focus:border-amber focus:outline-none focus:ring-2 focus:ring-amber/20"
        />
      ))}
    </div>
  );
}
