"use client";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { toPersianDigits } from "@/lib/format";

type Slide = {
  id: string;
  order: number;
  image: string;
  titleFa: string;
  subtitleFa: string;
  tagFa: string;
  bulletsFa: string;
  titleEn: string;
  subtitleEn: string;
  tagEn: string;
  bulletsEn: string;
  accent: string;
};

export function Onboarding() {
  const { t, isFa } = useT();
  const { setOnboardingSeen } = useApp();
  const [step, setStep] = useState(0);
  const [slides, setSlides] = useState<Slide[] | null>(null);

  useEffect(() => {
    fetch("/api/onboarding")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setSlides(data);
        else setSlides([]);
      })
      .catch(() => setSlides([]));
  }, []);

  // If no slides configured, skip onboarding — in useEffect, not render
  useEffect(() => {
    if (slides && slides.length === 0) {
      setOnboardingSeen(true);
    }
  }, [slides, setOnboardingSeen]);

  if (slides === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-black">
        <Loader2 className="size-8 animate-spin text-amber" />
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center bg-black">
        <Loader2 className="size-8 animate-spin text-amber" />
      </div>
    );
  }

  const isLast = step === slides.length - 1;
  const slide = slides[step];
  const title = isFa ? slide.titleFa : slide.titleEn;
  const subtitle = isFa ? slide.subtitleFa : slide.subtitleEn;
  const tag = isFa ? slide.tagFa : slide.tagEn;
  let bullets: string[] = [];
  try { bullets = JSON.parse(isFa ? slide.bulletsFa : slide.bulletsEn); } catch {}
  const accentClass = slide.accent === "emerald" ? "text-emerald-300" : "text-amber";

  const next = () => {
    if (isLast) setOnboardingSeen(true);
    else setStep((s) => s + 1);
  };

  // Use DB image or fallback to placeholder SVG
  const imgSrc = slide.image || `/onboarding/slide${step + 1}.svg`;

  return (
    <div className="relative min-h-screen overflow-hidden bg-black" dir={isFa ? "rtl" : "ltr"}>
      <AnimatePresence mode="popLayout">
        <motion.div
          key={`bg-${step}`}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0"
        >
          <img src={imgSrc} alt="" className="size-full object-cover" draggable={false} />
        </motion.div>
      </AnimatePresence>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-black/10 to-black/90" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] bg-gradient-to-t from-black/95 via-black/55 to-transparent" />

      {!isLast && (
        <button
          onClick={() => setOnboardingSeen(true)}
          className="absolute end-5 top-[max(1.25rem,env(safe-area-inset-top))] z-30 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/80 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white"
        >
          {t("onboarding.skip")}
        </button>
      )}

      <div className="absolute start-5 top-[max(1.25rem,env(safe-area-inset-top))] z-30 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 font-mono text-[10px] tracking-widest text-white/70 backdrop-blur-md">
        {isFa ? toPersianDigits(step + 1) : step + 1} / {isFa ? toPersianDigits(slides.length) : slides.length}
      </div>

      <div className="relative z-20 flex min-h-screen flex-col justify-end px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-24">
        <div className="mx-auto w-full max-w-md">
          <AnimatePresence mode="wait">
            <motion.div
              key={`content-${step}`}
              initial={{ opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1 backdrop-blur-md">
                <Sparkles className={`size-3 ${accentClass}`} />
                <span className={`text-[10px] font-semibold ${accentClass}`}>{tag}</span>
              </div>
              <h2 className="font-display text-2xl font-bold leading-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] sm:text-[1.75rem]">
                {title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/85 drop-shadow-[0_1px_4px_rgba(0,0,0,0.6)]">
                {subtitle}
              </p>
              <div className="mt-5 space-y-1.5">
                {bullets.map((b, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: isFa ? 12 : -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 + i * 0.08 }}
                    className="flex items-center gap-2.5 rounded-xl border border-white/15 bg-black/40 px-3 py-2 backdrop-blur-xl"
                  >
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-amber">
                      <ChevronRight className={`size-3 text-black ${isFa ? "rotate-180" : ""}`} strokeWidth={3} />
                    </span>
                    <span className="text-[12px] text-white/95">{b}</span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </AnimatePresence>

          <div className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-white/15 bg-black/40 p-3 backdrop-blur-xl">
            <div className="flex items-center gap-1.5">
              {slides.map((_, i) => (
                <button key={i} onClick={() => setStep(i)} className="p-1" aria-label={`Go to slide ${i + 1}`}>
                  <motion.span
                    animate={{ width: i === step ? 22 : 6, backgroundColor: i === step ? "#F5A524" : "rgba(255,255,255,0.3)" }}
                    transition={{ duration: 0.3 }}
                    className="block h-1.5 rounded-full"
                  />
                </button>
              ))}
            </div>
            <Button onClick={next} size="sm" className="bg-amber text-black hover:bg-amber/90 shadow-[0_4px_16px_rgba(245,165,36,0.35)]">
              {isLast ? (<><Sparkles className="me-1.5 size-3.5" />{t("onboarding.start")}</>) : (<>{t("onboarding.next")}<ChevronRight className={`ms-1.5 size-3.5 ${isFa ? "rotate-180" : ""}`} /></>)}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
