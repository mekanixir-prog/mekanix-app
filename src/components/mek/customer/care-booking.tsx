"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronLeft, Loader2, Check, Package, MapPin, Calendar, Clock,
  ShieldCheck, FileText,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";
import { formatTomanFromIrr } from "@/lib/money/irr";

type Package = {
  id: string; name: string; nameFa: string; description: string;
  basePrice: number; items: any[]; category: string;
};

export function CareBooking({ customer }: { customer: DemoUser }) {
  const { go, params, back } = useApp();
  const { isFa } = useT();
  const money = (amountIrr: number) => `${formatTomanFromIrr(amountIrr, isFa ? "fa-IR" : "en-US")} ${isFa ? "تومان" : "Toman"}`;
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPkg, setSelectedPkg] = useState<Package | null>(null);
  const [step, setStep] = useState<"packages" | "location" | "schedule" | "review">("packages");
  const [location, setLocation] = useState("");
  const [date, setDate] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [currentMileage, setCurrentMileage] = useState("");
  const [booking, setBooking] = useState(false);
  const [quote, setQuote] = useState<{ labor: number; travel: number; inspection: number; emergency: number; taxTotal: number; taxRate: number; total: number; currency: string; pricingVersion: string; breakdown: { includedDistanceKm: number } } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteReload, setQuoteReload] = useState(0);
  // Persist the pending operation key across remounts and same-payload retries.
  const bookingKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const vehicleId = params.vehicleId;

  useEffect(() => {
    fetch(`/api/care/packages?vehicleId=${vehicleId}`)
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d)) setPackages(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [vehicleId]);

  useEffect(() => {
    if (step !== "review" || !selectedPkg || !vehicleId) return;
    let active = true;
    setQuote(null);
    setQuoteError("");
    setQuoteLoading(true);
    void (async () => {
      try {
        const token = localStorage.getItem("mekanix-token");
        if (!token) throw new Error(isFa ? "برای دریافت تعرفه وارد حساب شوید." : "Sign in to retrieve the current rate.");
        const response = await fetch("/api/care/bookings/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ vehicleId, serviceType: "periodic" }),
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || (isFa ? "دریافت پیش‌فاکتور ناموفق بود." : "Could not load the quote."));
        if (active) setQuote(data.pricing);
      } catch (error) {
        if (active) setQuoteError(error instanceof Error ? error.message : (isFa ? "دریافت پیش‌فاکتور ناموفق بود." : "Could not load the quote."));
      } finally {
        if (active) setQuoteLoading(false);
      }
    })();
    return () => { active = false; };
  }, [step, selectedPkg?.id, vehicleId, quoteReload, isFa]);

  const timeWindows = [
    { value: "09:00-11:00", label: isFa ? "۹:۰۰ - ۱۱:۰۰" : "09:00 - 11:00" },
    { value: "11:00-13:00", label: isFa ? "۱۱:۰۰ - ۱۳:۰۰" : "11:00 - 13:00" },
    { value: "13:00-15:00", label: isFa ? "۱۳:۰۰ - ۱۵:۰۰" : "13:00 - 15:00" },
    { value: "15:00-17:00", label: isFa ? "۱۵:۰۰ - ۱۷:۰۰" : "15:00 - 17:00" },
  ];

  async function handleBooking() {
    setBooking(true);
    try {
      const payload = {
        vehicleId, packageId: selectedPkg?.id,
        serviceType: "periodic", expectedPricingVersion: quote?.pricingVersion, location,
        date: date || undefined, timeWindow: timeWindow || undefined,
        currentMileage: currentMileage ? parseInt(currentMileage) : undefined,
      };
      const fingerprint = JSON.stringify(payload);
      const storageKey = `mekanix-care-booking:${vehicleId ?? "new"}`;
      let activeKey = bookingKeyRef.current?.fingerprint === fingerprint
        ? bookingKeyRef.current.key
        : "";
      if (!activeKey) {
        try {
          const saved = sessionStorage.getItem(storageKey);
          const parsed = saved ? JSON.parse(saved) : null;
          activeKey = parsed?.fingerprint === fingerprint && typeof parsed?.key === "string"
            ? parsed.key
            : globalThis.crypto.randomUUID();
          sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key: activeKey }));
        } catch {
          activeKey = globalThis.crypto.randomUUID();
        }
        bookingKeyRef.current = { fingerprint, key: activeKey };
      }
      const token = localStorage.getItem("mekanix-token");
      const res = await fetch("/api/care/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": activeKey },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      try { sessionStorage.removeItem(`mekanix-care-booking:${vehicleId ?? "new"}`); } catch {}
      bookingKeyRef.current = null;
      toast.success(isFa ? "سفارش ثبت شد!" : "Booking created!");
      go("care-detail", { bookingId: data.id });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBooking(false);
    }
  }

  if (loading) {
    return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  }

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={back} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className={`size-5 ${isFa ? "rotate-180" : ""}`} />
        </button>
        <h1 className="text-2xl font-bold">{isFa ? "رزرو سرویس" : "Book Service"}</h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {["packages", "location", "schedule", "review"].map((s, i) => {
          const stepLabels = isFa
            ? ["پکیج", "محل", "زمان", "بررسی"]
            : ["Package", "Location", "Schedule", "Review"];
          const active = step === s;
          const done = ["packages", "location", "schedule", "review"].indexOf(step) > i;
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={`grid size-7 place-items-center rounded-full text-[10px] font-bold transition ${
                active ? "bg-amber text-black" : done ? "bg-emerald-glow text-black" : "bg-muted text-muted-foreground"
              }`}>
                {done ? <Check className="size-3" /> : isFa ? toPersianDigits(i + 1) : i + 1}
              </div>
              <span className={`text-[11px] ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                {stepLabels[i]}
              </span>
              {i < 3 && <div className={`h-px w-6 ${done ? "bg-emerald-glow" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      {/* Step: Packages */}
      {step === "packages" && (
        <div className="space-y-3">
          {packages.map((pkg, i) => (
            <motion.div
              key={pkg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
            >
              <button
                onClick={() => { setSelectedPkg(pkg); setStep("location"); }}
                className={`w-full rounded-xl border bg-card p-5 text-start transition hover:border-amber/40 ${
                  selectedPkg?.id === pkg.id ? "border-amber" : "border-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 place-items-center rounded-lg bg-amber/10">
                      <Package className="size-5 text-amber" />
                    </div>
                    <div>
                      <h3 className="font-bold">{isFa ? pkg.nameFa : pkg.name}</h3>
                      {pkg.description && <p className="text-xs text-muted-foreground mt-0.5">{pkg.description}</p>}
                    </div>
                  </div>
                  <div className="text-end">
                    <p className="text-xs text-muted-foreground">{isFa ? "تعرفه بر اساس نرخ‌نامه" : "Rate-card pricing"}</p>
                  </div>
                </div>
                {pkg.items && pkg.items.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {pkg.items.slice(0, 5).map((item: any, idx: number) => (
                      <span key={idx} className="rounded-full border border-border bg-background/50 px-2 py-0.5 text-[10px]">
                        {isFa ? item.itemNameFa : item.itemName}
                      </span>
                    ))}
                    {pkg.items.length > 5 && (
                      <span className="text-[10px] text-muted-foreground">+{isFa ? toPersianDigits(pkg.items.length - 5) : pkg.items.length - 5}</span>
                    )}
                  </div>
                )}
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* Step: Location */}
      {step === "location" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{isFa ? "آدرس" : "Address"}</label>
            <textarea
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={isFa ? "نشانی کامل محل سرویس" : "Full service address"}
              rows={3}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-amber focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{isFa ? "کیلومتر فعلی" : "Current Mileage"}</label>
            <input
              value={currentMileage}
              onChange={(e) => setCurrentMileage(e.target.value.replace(/\D/g, ""))}
              placeholder="72000"
              dir="ltr"
              inputMode="numeric"
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-mono focus:border-amber focus:outline-none"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("packages")} className="flex-1">{isFa ? "قبلی" : "Back"}</Button>
            <Button onClick={() => location ? setStep("schedule") : toast.error(isFa ? "آدرس الزامی است" : "Address required")} className="flex-1 bg-amber text-black hover:bg-amber/90">
              {isFa ? "بعدی" : "Next"}
            </Button>
          </div>
        </div>
      )}

      {/* Step: Schedule */}
      {step === "schedule" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{isFa ? "تاریخ" : "Date"}</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-amber focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{isFa ? "بازه زمانی" : "Time Window"}</label>
            <div className="grid grid-cols-2 gap-2">
              {timeWindows.map((tw) => (
                <button
                  key={tw.value}
                  onClick={() => setTimeWindow(tw.value)}
                  className={`rounded-lg border px-3 py-2.5 text-sm transition ${
                    timeWindow === tw.value ? "border-amber bg-amber/10 text-amber" : "border-border hover:bg-accent"
                  }`}
                >
                  {tw.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("location")} className="flex-1">{isFa ? "قبلی" : "Back"}</Button>
            <Button onClick={() => setStep("review")} className="flex-1 bg-amber text-black hover:bg-amber/90">
              {isFa ? "بررسی" : "Review"}
            </Button>
          </div>
        </div>
      )}

      {/* Step: Review */}
      {step === "review" && selectedPkg && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <Package className="size-4 text-amber" />
              <h3 className="font-bold">{isFa ? selectedPkg.nameFa : selectedPkg.name}</h3>
            </div>

            <div className="space-y-2 text-sm">
              <ReviewRow icon={MapPin} label={isFa ? "محل" : "Location"} value={location} />
              <ReviewRow icon={Calendar} label={isFa ? "تاریخ" : "Date"} value={date || (isFa ? "به‌محض تطبیق" : "ASAP")} />
              <ReviewRow icon={Clock} label={isFa ? "بازه زمانی" : "Time"} value={timeWindow || (isFa ? "هر زمان" : "Any time")} />
              {currentMileage && <ReviewRow icon={FileText} label={isFa ? "کیلومتر" : "Mileage"} value={`${isFa ? toPersianDigits(parseInt(currentMileage).toLocaleString()) : parseInt(currentMileage).toLocaleString()} km`} />}
            </div>

            <div className="border-t border-border pt-3 space-y-1.5">
              {quoteLoading && <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{isFa ? "در حال دریافت تعرفه معتبر…" : "Loading current rate…"}</div>}
              {quoteError && <div role="alert" className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500"><p>{quoteError}</p><Button type="button" variant="outline" onClick={() => setQuoteReload((n) => n + 1)}>{isFa ? "تلاش دوباره" : "Retry"}</Button></div>}
              {quote && <>
                <PriceRow label={isFa ? "دستمزد ثابت سرویس دوره‌ای" : "Fixed periodic-service labor"} amount={quote.labor} money={money} />
                <PriceRow label={isFa ? "اعزام پایه" : "Base dispatch"} amount={quote.travel} money={money} />
                <PriceRow label={isFa ? "بازدید و عیب‌یابی" : "Inspection and diagnosis"} amount={quote.inspection} money={money} />
                {quote.emergency > 0 && <PriceRow label={isFa ? "هزینه فوریت" : "Emergency surcharge"} amount={quote.emergency} money={money} />}
                <PriceRow label={isFa ? "مالیات" : "Tax"} amount={quote.taxTotal} money={money} muted />
                <div className="border-t border-border pt-2 flex items-center justify-between">
                  <span className="font-bold">{isFa ? "جمع پایه پیش‌فاکتور" : "Base quote total"}</span>
                  <span className="font-display text-xl font-bold text-amber">{money(quote.total)}</span>
                </div>
                <p className="pt-2 text-xs leading-6 text-muted-foreground">
                  {isFa
                    ? `این مبلغ بر اساس نسخه ${quote.pricingVersion} نرخ‌نامه و بدون قطعات و مسافت اضافه محاسبه شده است. مسافت مشمول اعزام ${toPersianDigits(quote.breakdown.includedDistanceKm)} کیلومتر است؛ هر هزینه اضافه فقط با اعلام و تأیید جداگانه قابل اعمال خواهد بود.`
                    : `Calculated from rate-card ${quote.pricingVersion}; parts and extra distance are excluded. The included dispatch distance is ${quote.breakdown.includedDistanceKm} km. Any additional charge must be disclosed and separately approved.`}
                </p>
              </>}
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-4 shrink-0" />
              {isFa ? "شرایط ضمانت، در صورت شمول، در توافق‌نامه همان سفارش مشخص می‌شود." : "Any applicable warranty terms are defined in the service agreement for this order."}
            </div>
          </div>

          <Button onClick={handleBooking} disabled={booking || quoteLoading || !quote || Boolean(quoteError)} className="w-full bg-amber text-black hover:bg-amber/90">
            {booking ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Check className="mr-2 size-4" />}
            {isFa ? "تأیید و رزرو" : "Confirm & Book"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function PriceRow({ label, amount, money, muted }: { label: string; amount: number; money: (n: number) => string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted-foreground" : ""}>{label}</span>
      <span className={`tabular-nums ${muted ? "text-muted-foreground" : "font-medium"}`}>{money(amount)}</span>
    </div>
  );
}
