"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw, Wallet } from "lucide-react";
import { apiFetch } from "@/lib/admin-api-client";
import { Badge } from "@/components/ui/badge";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { useT } from "@/lib/use-t";
import { fmtDateTime } from "@/lib/format";

type Withdrawal = {
  id: string;
  code: string;
  walletId: string;
  amount: number | string;
  method: string;
  status: string;
  requestedAt: string;
  hasRefundLedger: boolean;
  wallet?: { technician?: { user?: { name?: string; phone?: string | null } } };
};

const STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PAID",
  "REJECTED",
  "REFUND_PENDING",
  "REFUND_PROCESSING",
  "RECONCILIATION_NEEDED",
];

export function AdminWithdrawals() {
  const { isFa, money, lang } = useT();
  const [rows, setRows] = useState<Withdrawal[] | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [notes, setNotes] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const text = (fa: string, en: string) => (isFa ? fa : en);
  const load = useCallback(async () => {
    setError(null);
    const query = filter === "ALL" ? "" : `?status=${encodeURIComponent(filter)}`;
    try {
      const data = await apiFetch<Withdrawal[]>(`/api/admin/withdrawals${query}`);
      setRows(data);
    } catch (e) {
      setRows([]);
      setError(e instanceof Error ? e.message : text("بارگذاری درخواست‌ها ناموفق بود", "Could not load withdrawals"));
    }
  }, [filter, isFa]);

  useEffect(() => { void load(); }, [load]);

  const act = async (row: Withdrawal, action: "APPROVE" | "REJECT") => {
    const prompt = action === "APPROVE"
      ? text("این درخواست برداشت تأیید شود؟", "Approve this withdrawal?")
      : row.status === "REFUND_PENDING"
        ? text("بازپرداخت اتمیک دوباره اجرا شود؟", "Retry the atomic refund?")
        : text("درخواست رد و مبلغ به کیف پول بازگردانده شود؟", "Reject and atomically refund this withdrawal?");
    if (typeof window !== "undefined" && !window.confirm(prompt)) return;

    setBusyId(row.id);
    setError(null);
    try {
      await apiFetch(`/api/admin/withdrawals/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: { action, notes: notes.trim() || undefined },
      });
      setNotes("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : text("عملیات ناموفق بود", "Action failed"));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, [string, string]> = {
      REQUESTED: ["در انتظار بررسی", "Requested"],
      APPROVED: ["تأیید شده", "Approved"],
      PAID: ["پرداخت شده", "Paid"],
      REJECTED: ["رد شده", "Rejected"],
      REFUND_PENDING: ["بازپرداخت در انتظار اجرا", "Refund pending"],
      REFUND_PROCESSING: ["پردازش بازپرداخت متوقف شده", "Refund processing interrupted"],
      RECONCILIATION_NEEDED: ["نیازمند تطبیق دستی", "Manual reconciliation"],
    };
    const label = labels[status] ?? [status, status];
    return text(label[0], label[1]);
  };

  const statusVariant = (status: string) => {
    if (status === "REJECTED" || status === "PAID") return "default" as const;
    if (status === "RECONCILIATION_NEEDED" || status === "REFUND_PROCESSING") return "destructive" as const;
    if (status === "REFUND_PENDING" || status === "REQUESTED") return "secondary" as const;
    return "outline" as const;
  };

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader
        title={text("مدیریت برداشت‌ها", "Withdrawal management")}
        subtitle={text("بازبینی درخواست‌ها و بررسی سند بازپرداخت؛ وضعیت‌های مبهم بدون اعتباردهی خودکار نمایش داده می‌شوند.", "Review requests and refund evidence. Ambiguous states are never auto-credited.")}
      />

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{text("فیلتر وضعیت", "Status filter")}</span>
          <select className="h-10 min-w-56 rounded-lg border bg-background px-3" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="ALL">{text("همه وضعیت‌ها", "All statuses")}</option>
            {STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm sm:max-w-xl">
          <span className="font-medium">{text("یادداشت مدیر (اختیاری)", "Admin note (optional)")}</span>
          <input className="h-10 rounded-lg border bg-background px-3" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={text("دلیل بررسی یا رد درخواست", "Reason for review or rejection")} />
        </label>
        <button type="button" onClick={() => void load()} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
          <RefreshCw className="size-4" /> {text("به‌روزرسانی", "Refresh")}
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      <div className="space-y-3">
        {rows === null ? (
          <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin" /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Wallet} title={text("درخواستی پیدا نشد", "No withdrawals found")} />
        ) : rows.map((row) => {
          const name = row.wallet?.technician?.user?.name || text("نامشخص", "Unknown");
          const phone = row.wallet?.technician?.user?.phone;
          const ambiguous = row.status === "REFUND_PROCESSING" || row.status === "RECONCILIATION_NEEDED" || (row.status === "REJECTED" && !row.hasRefundLedger);
          return (
            <article key={row.id} className="space-y-3 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{row.code}</span>
                    <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                  </div>
                  <div className="text-sm font-medium">{name}{phone ? <span className="ms-2 text-muted-foreground">{phone}</span> : null}</div>
                  <div className="text-xs text-muted-foreground">{text("ثبت:", "Requested:")} {fmtDateTime(row.requestedAt, lang)} · {text("روش:", "Method:")} {row.method}</div>
                </div>
                <div className="text-lg font-semibold tabular-nums">{money(Number(row.amount))}</div>
              </div>

              {row.status === "REJECTED" && row.hasRefundLedger && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-2 text-sm text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-4 shrink-0" /> {text("سند بازپرداخت در دفترکل موجود است.", "Refund ledger proof exists.")}
                </div>
              )}
              {ambiguous && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <span>{text("اعتباردهی خودکار مسدود است. موجودی کیف پول و دفترکل را با سوابق بانکی تطبیق دهید؛ تا روشن‌شدن نتیجه، دوباره وجهی اضافه نکنید.", "Automatic credit is blocked. Reconcile wallet balance and ledger against bank records; do not credit again until the outcome is verified.")}</span>
                </div>
              )}
              {row.status === "REFUND_PENDING" && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm">
                  <Clock3 className="mt-0.5 size-4 shrink-0" />
                  <span>{text("این درخواست برای بازپرداخت اتمیک آماده است؛ تکرار امن فقط از همین وضعیت انجام شود.", "The request is eligible for atomic refund retry from this state only.")}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {row.status === "REQUESTED" && <>
                  <button disabled={busyId === row.id} onClick={() => void act(row, "APPROVE")} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                    {busyId === row.id ? text("در حال پردازش…", "Working…") : text("تأیید برداشت", "Approve")}
                  </button>
                  <button disabled={busyId === row.id} onClick={() => void act(row, "REJECT")} className="rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive disabled:opacity-50">
                    {text("رد و بازپرداخت", "Reject & refund")}
                  </button>
                </>}
                {row.status === "REFUND_PENDING" && (
                  <button disabled={busyId === row.id} onClick={() => void act(row, "REJECT")} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50">
                    <RefreshCw className="size-4" /> {text("تلاش مجدد بازپرداخت", "Retry refund")}
                  </button>
                )}
                {ambiguous && <span className="self-center text-xs text-destructive">{text("اقدام خودکار غیرفعال است", "Automatic actions disabled")}</span>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
