"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from "lucide-react";

type OutboxStatus = "PENDING" | "PROCESSING" | "PROCESSED" | "DEAD";
type OutboxEvent = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  processedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
type OutboxResponse = {
  summary: { pending: number; processing: number; processed: number; dead: number };
  events: OutboxEvent[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  readOnly: true;
};

const STATUS_LABEL: Record<OutboxStatus, string> = {
  PENDING: "در انتظار پردازش",
  PROCESSING: "در حال پردازش",
  PROCESSED: "پردازش‌شده",
  DEAD: "متوقف‌شده (DEAD)",
};
const STATUS_STYLE: Record<OutboxStatus, string> = {
  PENDING: "border-amber/30 bg-amber/10 text-amber-700 dark:text-amber-300",
  PROCESSING: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  PROCESSED: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  DEAD: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function SummaryCard({ title, value, icon: Icon, tone }: {
  title: string; value: number; icon: typeof Activity; tone: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{title}</span>
        <span className={`grid size-9 place-items-center rounded-xl ${tone}`}><Icon size={18} /></span>
      </div>
      <div className="mt-3 text-2xl font-bold tabular-nums">{value.toLocaleString("fa-IR")}</div>
    </div>
  );
}

export default function PaymentOutboxPage() {
  const [data, setData] = useState<OutboxResponse | null>(null);
  const [status, setStatus] = useState<"ALL" | OutboxStatus>("ALL");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const load = useCallback(async (nextPage = page, nextStatus = status) => {
    setLoading(true);
    setError("");
    setUnauthorized(false);
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "20" });
      if (nextStatus !== "ALL") params.set("status", nextStatus);
      const response = await fetch(`/api/admin-panel/payment-outbox?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401) {
        setUnauthorized(true);
        setData(null);
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "دریافت اطلاعات صف پرداخت ناموفق بود");
      setData(body as OutboxResponse);
      setLastUpdated(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خطای ناشناخته در دریافت اطلاعات");
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => { void load(page, status); }, [load, page, status]);

  function changeStatus(next: "ALL" | OutboxStatus) {
    setStatus(next);
    setPage(1);
  }

  const summary = data?.summary ?? { pending: 0, processing: 0, processed: 0, dead: 0 };
  const tabs: Array<{ value: "ALL" | OutboxStatus; label: string }> = [
    { value: "ALL", label: "همه رویدادها" },
    { value: "PENDING", label: "در انتظار" },
    { value: "PROCESSING", label: "در حال پردازش" },
    { value: "PROCESSED", label: "موفق" },
    { value: "DEAD", label: "متوقف‌شده" },
  ];

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/70">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/admin-panel" aria-label="بازگشت به پنل مدیریت" className="grid size-10 place-items-center rounded-xl border border-border hover:bg-accent">
              <ArrowRight size={18} />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold tracking-[0.18em] text-amber">MEKANIX / OPERATIONS</span>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">فقط خواندنی</span>
              </div>
              <h1 className="mt-1 text-lg font-bold sm:text-xl">پایش صف رویدادهای پرداخت</h1>
            </div>
          </div>
          <button onClick={() => void load(page, status)} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-amber/50 disabled:opacity-50">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            <span className="hidden sm:inline">به‌روزرسانی</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        {unauthorized ? (
          <div className="rounded-2xl border border-amber/30 bg-amber/5 p-6 text-center">
            <ShieldCheck className="mx-auto mb-3 text-amber" size={30} />
            <h2 className="font-bold">ورود مدیر لازم است</h2>
            <p className="mt-2 text-sm text-muted-foreground">برای مشاهدهٔ اطلاعات عملیاتی، ابتدا وارد پنل مدیریت شوید.</p>
            <Link href="/admin-panel" className="mt-4 inline-flex rounded-xl bg-amber px-4 py-2 text-sm font-semibold text-black">ورود به پنل</Link>
          </div>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard title="در انتظار پردازش" value={summary.pending} icon={Clock3} tone="bg-amber/10 text-amber-700 dark:text-amber-300" />
              <SummaryCard title="در حال پردازش" value={summary.processing} icon={Activity} tone="bg-sky-500/10 text-sky-700 dark:text-sky-300" />
              <SummaryCard title="پردازش موفق" value={summary.processed} icon={CheckCircle2} tone="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" />
              <SummaryCard title="نیازمند بررسی" value={summary.dead} icon={AlertTriangle} tone="bg-red-500/10 text-red-700 dark:text-red-300" />
            </section>

            <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div>
                  <h2 className="font-bold">رویدادهای ثبت‌شده</h2>
                  <p className="mt-1 text-xs text-muted-foreground">محتوای payload و اطلاعات مشتری در این صفحه نمایش داده نمی‌شود.</p>
                </div>
                <div className="text-xs text-muted-foreground">
                  {lastUpdated ? `آخرین دریافت: ${formatDate(lastUpdated)}` : "در انتظار دریافت اطلاعات"}
                </div>
              </div>

              <div className="flex gap-2 overflow-x-auto border-b border-border px-4 py-3 sm:px-5">
                {tabs.map(tab => (
                  <button key={tab.value} onClick={() => changeStatus(tab.value)} className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition ${status === tab.value ? "bg-foreground text-background" : "border border-border text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
                    {tab.label}
                  </button>
                ))}
              </div>

              {error && <div role="alert" className="m-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-right text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">رویداد</th>
                      <th className="px-4 py-3 font-medium">شناسه تجمیع</th>
                      <th className="px-4 py-3 font-medium">وضعیت</th>
                      <th className="px-4 py-3 font-medium">تلاش</th>
                      <th className="px-4 py-3 font-medium">زمان ثبت</th>
                      <th className="px-4 py-3 font-medium">آخرین خطا</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {loading ? (
                      <tr><td colSpan={6} className="px-4 py-16 text-center text-muted-foreground"><RefreshCw className="mx-auto mb-2 animate-spin" size={20} />در حال دریافت اطلاعات…</td></tr>
                    ) : data?.events.length ? data.events.map(event => (
                      <tr key={event.id} className="align-top transition hover:bg-muted/30">
                        <td className="px-4 py-4">
                          <div className="font-semibold">{event.eventType}</div>
                          <div className="mt-1 max-w-56 break-all font-mono text-[10px] text-muted-foreground">{event.id}</div>
                          <div className="mt-1 max-w-56 break-all font-mono text-[10px] text-muted-foreground">{event.idempotencyKey}</div>
                        </td>
                        <td className="px-4 py-4">
                          <div>{event.aggregateType}</div>
                          <div className="mt-1 font-mono text-xs text-muted-foreground">{event.aggregateId}</div>
                        </td>
                        <td className="px-4 py-4"><span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLE[event.status]}`}>{STATUS_LABEL[event.status] ?? event.status}</span></td>
                        <td className="px-4 py-4 tabular-nums">{event.attempts.toLocaleString("fa-IR")}</td>
                        <td className="whitespace-nowrap px-4 py-4 text-xs text-muted-foreground">{formatDate(event.createdAt)}</td>
                        <td className="max-w-64 px-4 py-4 text-xs text-muted-foreground">{event.lastError || "—"}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">{error ? "داده‌ای برای نمایش دریافت نشد." : "برای این فیلتر رویدادی وجود ندارد."}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col gap-3 border-t border-border px-4 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <span>{data ? `نمایش ${data.events.length.toLocaleString("fa-IR")} مورد از ${data.pagination.total.toLocaleString("fa-IR")} رویداد` : "—"}</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(value => Math.max(1, value - 1))} disabled={loading || page <= 1} className="rounded-lg border border-border px-3 py-2 hover:bg-accent disabled:opacity-40">قبلی</button>
                  <span className="min-w-20 text-center tabular-nums">{(data?.pagination.page ?? page).toLocaleString("fa-IR")} از {(data?.pagination.totalPages ?? 1).toLocaleString("fa-IR")}</span>
                  <button onClick={() => setPage(value => value + 1)} disabled={loading || !data || page >= data.pagination.totalPages} className="rounded-lg border border-border px-3 py-2 hover:bg-accent disabled:opacity-40">بعدی</button>
                </div>
              </div>
            </section>

            <div className="flex items-start gap-3 rounded-xl border border-amber/20 bg-amber/5 p-4 text-xs leading-6 text-muted-foreground">
              <ShieldCheck className="mt-0.5 shrink-0 text-amber" size={18} />
              <p>این ابزار صرفاً برای مشاهده و عیب‌یابی است. رویدادهای متوقف‌شده را پیش از هر اقدام احتمالی باید با تراکنش، گزارش درگاه و وضعیت اشتراک تطبیق داد. در این نسخه هیچ امکان اجرای مجدد، تغییر وضعیت یا حذف رویداد وجود ندارد.</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
