"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LABOR_CATEGORIES, rateCardIrrToTomanInput,
  type AssetClass, type LaborCategory, type RateCardTomanInput,
} from "@/lib/money/rate-card";

type Snapshot = { version: number; updatedAt: string; updatedBy: string; rateCard: any };
type Envelope = { current: Snapshot; history: Snapshot[] };

const labels: Record<LaborCategory, string> = {
  diagnostics: "عیب‌یابی", electrical: "برق", cooling: "سیستم خنک‌کننده",
  brakesSuspension: "ترمز و تعلیق", periodic: "سرویس دوره‌ای",
  minorEngine: "تعمیرات جزئی موتور", majorEngine: "تعمیرات اساسی موتور",
  transmission: "گیربکس", hydraulics: "هیدرولیک", undercarriage: "زیربندی و شاسی",
};
const numberFa = (value: number) => new Intl.NumberFormat("fa-IR").format(value);

export default function PricingAdminPage() {
  const [data, setData] = useState<Envelope | null>(null);
  const [form, setForm] = useState<RateCardTomanInput | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin-panel/pricing", { credentials: "same-origin", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "بارگذاری تعرفه ناموفق بود");
      setData(result);
      setForm(rateCardIrrToTomanInput(result.current.rateCard));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطای ارتباط با سرور");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function updateAsset(asset: AssetClass, field: "dispatchToman" | "inspectionToman" | "includedDistanceKm" | "extraDistanceTomanPerKm", value: number) {
    if (!form) return;
    setForm({ ...form, [asset]: { ...form[asset], [field]: value } });
  }
  function updateLabor(asset: AssetClass, category: LaborCategory, value: number) {
    if (!form) return;
    setForm({ ...form, [asset]: { ...form[asset], laborToman: { ...form[asset].laborToman, [category]: value } } });
  }
  function updateVip(field: "passengerAnnualToman" | "heavyAnnualToman", value: number) {
    if (!form) return;
    setForm({ ...form, vip: { ...form.vip, [field]: value } });
  }

  async function save() {
    if (!form || !data) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin-panel/pricing", {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: data.current.version, ratesToman: form }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "ذخیره تعرفه ناموفق بود");
      setData(result);
      setForm(rateCardIrrToTomanInput(result.current.rateCard));
      setNotice("نسخه جدید تعرفه ذخیره شد.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "خطای ذخیره‌سازی");
    } finally { setSaving(false); }
  }

  if (loading) return <main dir="rtl" className="grid min-h-screen place-items-center bg-background text-foreground">در حال بارگذاری تعرفه‌ها…</main>;
  if (!data || !form) return (
    <main dir="rtl" className="mx-auto max-w-3xl p-6 text-foreground">
      <a href="/admin-panel" className="text-amber-600">بازگشت به پنل مدیریت</a>
      <p className="mt-6 text-red-500">{error || "اطلاعات تعرفه در دسترس نیست"}</p>
      <button onClick={() => void load()} className="mt-4 rounded-lg border px-4 py-2">تلاش مجدد</button>
    </main>
  );

  const renderAsset = (asset: AssetClass, title: string) => {
    const fields: Array<{ key: "dispatchToman" | "inspectionToman" | "includedDistanceKm" | "extraDistanceTomanPerKm"; label: string }> = [
      { key: "dispatchToman", label: "هزینه اعزام (تومان)" },
      { key: "inspectionToman", label: "هزینه کارشناسی (تومان)" },
      { key: "includedDistanceKm", label: "مسافت شامل‌شده (کیلومتر)" },
      { key: "extraDistanceTomanPerKm", label: "هر کیلومتر اضافه (تومان)" },
    ];
    return (
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="mb-4 text-lg font-bold">{title}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{field.label}</span>
              <input type="number" min="0" step="1" value={form[asset][field.key]}
                onChange={(event) => updateAsset(asset, field.key, Number(event.target.value))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left" dir="ltr" />
            </label>
          ))}
        </div>
        <h3 className="mb-3 mt-6 font-semibold">دستمزد ثابت خدمات (تومان)</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {LABOR_CATEGORIES.filter((category) => form[asset].laborToman[category] !== undefined || asset === "heavy").map((category) => (
            <label key={category} className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{labels[category]}</span>
              <input type="number" min="0" step="1" value={form[asset].laborToman[category] ?? 0}
                onChange={(event) => updateLabor(asset, category, Number(event.target.value))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-left" dir="ltr" />
            </label>
          ))}
        </div>
      </section>
    );
  };

  return (
    <main dir="rtl" className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <a href="/admin-panel" className="text-sm text-amber-600">← بازگشت به پنل مدیریت</a>
            <h1 className="mt-2 text-2xl font-bold">مدیریت تعرفه‌های MEKANIX</h1>
            <p className="mt-1 text-sm text-muted-foreground">نسخه {numberFa(data.current.version)} · ذخیره حسابداری به ریال، ویرایش به تومان</p>
          </div>
          <button onClick={() => void load()} className="rounded-lg border border-border px-4 py-2 text-sm">بارگذاری مجدد</button>
        </header>

        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          نرخ‌های اولیه مطابق مصوبه ۴ نوامبر ثبت شده‌اند. تغییر تعرفه به‌تنهایی رزرو، فاکتور، پرداخت یا VIP را فعال نمی‌کند.
          مالیات و کمیسیون غیرفعال‌اند و فروش VIP نیز تا تکمیل چرخه پرداخت خاموش می‌ماند.
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-500">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-emerald-500/30 p-3 text-sm text-emerald-600">{notice}</p>}

        {renderAsset("passenger", "خودروهای سواری خارجی")}
        {renderAsset("heavy", "ماشین‌آلات سنگین")}

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 text-lg font-bold">قواعد عمومی</h2>
          <label className="block max-w-sm text-sm">
            <span className="mb-1 block text-muted-foreground">اضافه‌هزینه اضطراری روی دستمزد (درصد)</span>
            <input type="number" min="0" max="100" step="1" value={form.emergencyLaborSurchargePercent}
              onChange={(event) => setForm({ ...form, emergencyLaborSurchargePercent: Number(event.target.value) })}
              className="w-full rounded-lg border border-border bg-background px-3 py-2" dir="ltr" />
          </label>
          <p className="mt-3 text-sm text-muted-foreground">سقف تخفیف دستی: ۱۰٪ (ثابت طبق مصوبه؛ پایه محاسبه تخفیف تا تعیین قاعده مالی جداگانه فعال نمی‌شود).</p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-2 text-lg font-bold">پیشنهاد VIP سالانه</h2>
          <p className="mb-4 text-sm text-muted-foreground">چهار بازدید دوره‌ای در سال؛ فقط اعزام و کارشناسی. تعمیر، قطعات و مسافت اضافه شامل نیست. فروش VIP غیرفعال است.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">سواری (تومان/سال)
              <input type="number" min="0" step="1" value={form.vip.passengerAnnualToman} onChange={(event) => updateVip("passengerAnnualToman", Number(event.target.value))} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2" dir="ltr" />
            </label>
            <label className="text-sm">ماشین‌آلات سنگین (تومان/سال)
              <input type="number" min="0" step="1" value={form.vip.heavyAnnualToman} onChange={(event) => updateVip("heavyAnnualToman", Number(event.target.value))} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2" dir="ltr" />
            </label>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">تعداد بازدید سالانه (۴) و وضعیت فروش غیرفعال از این صفحه قابل تغییر نیست.</p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-3 font-bold">تاریخچه نسخه‌ها</h2>
          {data.history.length === 0 ? <p className="text-sm text-muted-foreground">هنوز نسخه قبلی ثبت نشده است.</p> : (
            <div className="space-y-2">
              {data.history.map((item) => (
                <div key={item.version} className="flex flex-wrap justify-between gap-2 border-b border-border py-2 text-sm">
                  <span>نسخه {numberFa(item.version)}</span>
                  <span className="text-muted-foreground">{new Date(item.updatedAt).toLocaleString("fa-IR")}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">۲۰ نسخه اخیر نگهداری می‌شود؛ قیمت‌های ثبت‌شده در سوابق قبلی بازنویسی نمی‌شوند.</p>
        </section>

        <footer className="flex flex-wrap justify-end gap-3">
          <button onClick={() => void load()} disabled={saving} className="rounded-lg border border-border px-5 py-3 text-sm">لغو تغییرات</button>
          <button onClick={() => void save()} disabled={saving} className="rounded-lg bg-amber-500 px-6 py-3 text-sm font-semibold text-black disabled:opacity-50">{saving ? "در حال ذخیره…" : "ذخیره نسخه جدید تعرفه"}</button>
        </footer>
      </div>
    </main>
  );
}
