"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, CircleHelp, Clock3, Cloud, CloudOff,
  Loader2, RefreshCw, RotateCcw, SearchCheck, ShieldAlert, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { authFetch } from "@/lib/fetch-with-auth";
import {
  dequeueAction, getQueuedActions, retryAfterReconciliation, type QueuedAction,
} from "@/lib/offline-queue";
import type { SyncResult } from "@/lib/sync-engine";

type ServerCheck = {
  state: "COMMITTED" | "NOT_COMMITTED" | "RECONCILIATION_REQUIRED" | "KEY_CONFLICT" | "UNKNOWN";
  label?: string;
  detail?: string;
  retryAllowed?: boolean;
  checkedAt: number;
};

type Props = {
  open: boolean;
  isOnline: boolean;
  queueSize: number;
  isFa: boolean;
  lang: string;
  onSync: (actionIds?: string[]) => Promise<SyncResult>;
};

function getPath(action: QueuedAction): string {
  try {
    return new URL(action.url, window.location.origin).pathname;
  } catch {
    return "";
  }
}

function getBody(action: QueuedAction): Record<string, unknown> {
  if (action.body && typeof action.body === "object" && !Array.isArray(action.body)) {
    return action.body as Record<string, unknown>;
  }
  if (typeof action.body === "string") {
    try {
      const parsed = JSON.parse(action.body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function operationLabel(action: QueuedAction, isFa: boolean): string {
  const path = getPath(action);
  if (path === "/api/wallets/withdraw") return isFa ? "درخواست برداشت وجه" : "Wallet withdrawal";
  if (path === "/api/prepay") return isFa ? "پرداخت پیش‌خدمت" : "Pre-service payment";
  if (path === "/api/gateway/verify") return isFa ? "تأیید پرداخت آزمایشی" : "Simulator payment verification";
  if (path.startsWith("/api/care/bookings")) return isFa ? "رزرو سرویس" : "Service booking";
  if (path.startsWith("/api/service-requests")) return isFa ? "درخواست تعمیر" : "Repair request";
  return isFa ? "عملیات ثبت‌نشده در صف" : "Queued operation";
}

function affectedResource(action: QueuedAction, isFa: boolean): string {
  const path = getPath(action);
  const body = getBody(action);
  const short = (value: unknown) => typeof value === "string" && value.trim()
    ? value.trim().slice(0, 48)
    : null;
  if (path === "/api/prepay") {
    const jobId = short(body.jobId);
    return jobId ? `${isFa ? "کار" : "Job"} · ${jobId}` : (isFa ? "کار مرتبط با پرداخت" : "Related job");
  }
  if (path.startsWith("/api/care/bookings")) {
    const vehicleId = short(body.vehicleId);
    return vehicleId ? `${isFa ? "وسیله" : "Vehicle"} · ${vehicleId}` : (isFa ? "رزرو سرویس" : "Service booking");
  }
  if (path.startsWith("/api/service-requests")) {
    const vehicleId = short(body.vehicleId);
    return vehicleId ? `${isFa ? "وسیله" : "Vehicle"} · ${vehicleId}` : (isFa ? "درخواست تعمیر جدید" : "New repair request");
  }
  if (path.startsWith("/api/insurance/claim")) {
    const policyId = short(body.policyId);
    return policyId ? `${isFa ? "بیمه‌نامه" : "Policy"} · ${policyId}` : (isFa ? "پرونده خسارت" : "Insurance claim");
  }
  if (path === "/api/wallets/withdraw") return isFa ? "درخواست برداشت وجه" : "Withdrawal request";
  return isFa ? "منبع درخواستی مشخص نشده" : "Resource not specified";
}

function reasonLabel(action: QueuedAction, isFa: boolean): string {
  const labels: Record<string, [string, string]> = {
    network_error: ["قطع ارتباط هنگام ارسال؛ ممکن است سرور عملیات را ثبت کرده باشد", "Network failure; the server may have committed the action"],
    server_error: ["خطای سرور؛ نتیجه نهایی عملیات قطعی نیست", "Server error; the final outcome is uncertain"],
    conflict: ["تعارض با وضعیت ثبت‌شده در سرور", "Conflict with server-side state"],
    cross_origin: ["نشانی مقصد خارج از دامنه مکانیکس است؛ ارسال مسدود شد", "Cross-origin destination blocked; action was not sent"],
    unexpected_response: ["پاسخ غیرمنتظره از سرور دریافت شد", "Unexpected server response"],
    retry_limit: ["حد مجاز تلاش خودکار تمام شده؛ عملیات برای بررسی نگه داشته شد", "Automatic retry limit reached; action retained for review"],
    rate_limited: ["محدودیت تعداد درخواست؛ ارسال بعدی نیازمند بررسی است", "Rate limited; another attempt requires review"],
    auth_required: ["نشست کاربری منقضی یا نامعتبر است؛ دوباره وارد شوید و سپس وضعیت عملیات را بررسی کنید", "Session expired or invalid; sign in again, then check the operation status"],
    permission_denied: ["دسترسی این حساب برای عملیات کافی نیست", "This account is not authorized for the operation"],
    client_rejected: ["سرور درخواست را نپذیرفت؛ جزئیات باید بررسی شود", "The server rejected the request; review is required"],
    simulator_disabled: ["این مسیر آزمایشی در محیط عملیاتی غیرفعال است؛ تا تکمیل اتصال واقعی نگه داشته شود", "This simulator route is disabled in production; keep the action until the live integration is ready"],
    legacy_unknown: ["وضعیت عملیات مشخص نیست و باید دستی بررسی شود", "Operation state is unknown and needs review"],
  };
  const pair = labels[action.reconciliationReason ?? "legacy_unknown"] ?? labels.legacy_unknown;
  return isFa ? pair[0] : pair[1];
}

function formatDate(value: number | undefined, lang: string): string {
  if (!value || !Number.isFinite(value)) return "—";
  try {
    return new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-GB", {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

export function OfflineReconciliationCenter({ open, isOnline, queueSize, isFa, lang, onSync }: Props) {
  const [actions, setActions] = useState<QueuedAction[]>([]);
  const [checks, setChecks] = useState<Record<string, ServerCheck>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = useMemo(() => isFa ? {
    title: "مرکز همگام‌سازی و بررسی عملیات آفلاین",
    waitingTitle: "عملیات در انتظار همگام‌سازی",
    waitingDescription: "این موارد هنوز به‌صورت امن ارسال نشده‌اند. با اتصال اینترنت می‌توانید همگام‌سازی را اجرا کنید.",
    description: "هیچ عملیات مبهمی بدون بررسی وضعیت سرور دوباره ارسال یا حذف نمی‌شود.",
    online: "اتصال برقرار است",
    offline: "بدون اتصال به اینترنت",
    refresh: "همگام‌سازی امن",
    empty: "عملیات معوق یا نیازمند بررسی وجود ندارد.",
    created: "زمان ایجاد",
    attempted: "آخرین تلاش",
    retries: "تعداد تلاش",
    resource: "منبع مرتبط",
    reference: "شناسه محلی",
    reason: "علت بررسی",
    status: "وضعیت سرور",
    check: "بررسی وضعیت سرور",
    checking: "در حال بررسی…",
    committed: "سرور ثبت عملیات را تأیید کرد",
    notCommitted: "عملیات در سرور ثبت نشده است",
    partial: "سوابق مالی ناقص یا ناسازگار است؛ بررسی مدیر لازم است",
    keyConflict: "این کلید به عملیات دیگری تعلق دارد",
    unknown: "برای این نوع عملیات بررسی خودکار وضعیت در دسترس نیست",
    markDone: "تأیید ثبت و حذف از صف",
    retry: "ارسال دوباره امن",
    cancel: "لغو و حذف از دستگاه",
    confirm: "از حذف این عملیات معوق مطمئن هستید؟ این کار فقط نسخه محلی را حذف می‌کند و وضعیت سرور را تغییر نمی‌دهد.",
    yesDelete: "بله، حذف شود",
    keep: "نگه‌داشتن",
    notConfirmed: "مکانیکس هنوز نتیجه ثبت این عملیات را در سرور تأیید نکرده است.",
    retryNote: "ارسال مجدد فقط پس از بررسی قطعی وضعیت سرور و برای مسیرهای دارای قرارداد تکرارپذیری فعال می‌شود.",
    retryDisabled: "این مسیر هنوز در محیط عملیاتی فعال نیست؛ عملیات را نگه دارید تا اتصال درگاه واقعی تکمیل شود.",
    syncDone: "همگام‌سازی انجام شد",
    syncError: "همگام‌سازی ناموفق بود",
    noStatus: "بررسی وضعیت",
    http: "کد پاسخ",
  } : {
    title: "Offline sync and reconciliation",
    waitingTitle: "Actions waiting to sync",
    waitingDescription: "These actions have not been sent yet. Connect to the internet and run safe sync when ready.",
    description: "Ambiguous actions are never silently replayed or discarded.",
    online: "Connected",
    offline: "Offline",
    refresh: "Safe sync",
    empty: "No queued or unresolved actions.",
    created: "Created",
    attempted: "Last attempt",
    retries: "Attempts",
    resource: "Affected resource",
    reference: "Local reference",
    reason: "Review reason",
    status: "Server state",
    check: "Check server state",
    checking: "Checking…",
    committed: "Server confirms the operation was recorded",
    notCommitted: "Operation was not recorded on the server",
    partial: "Financial records are incomplete or inconsistent; admin review is required",
    keyConflict: "This key belongs to a different operation",
    unknown: "No authoritative status lookup is available for this operation",
    markDone: "Confirm completion and remove",
    retry: "Retry safely",
    cancel: "Cancel and remove locally",
    confirm: "Remove this queued action from this device? This does not change server state.",
    yesDelete: "Yes, remove",
    keep: "Keep it",
    notConfirmed: "MEKANIX has not confirmed whether this action committed on the server.",
    retryNote: "Retry is enabled only after an authoritative status check and for routes with durable idempotency.",
    retryDisabled: "This route is not enabled in production yet. Keep the action until the live payment integration is approved.",
    syncDone: "Sync completed",
    syncError: "Sync failed",
    noStatus: "Status lookup",
    http: "HTTP status",
  }, [isFa]);

  useEffect(() => {
    if (open) {
      setActions(getQueuedActions());
      setError(null);
    }
  }, [open, queueSize]);

  const refresh = () => setActions(getQueuedActions());
  const reviewActions = actions.filter((action) => action.needsReconciliation);
  const waitingCount = actions.length - reviewActions.length;

  async function checkServer(action: QueuedAction) {
    if (!isOnline) return;
    setBusyId(action.id);
    setError(null);
    try {
      const path = getPath(action);
      let endpoint: string | null = null;
      if (path === "/api/wallets/withdraw" && action.idempotencyKey) {
        endpoint = `/api/wallets/withdraw/status?key=${encodeURIComponent(action.idempotencyKey)}`;
      } else if (path === "/api/prepay") {
        const jobId = getBody(action).jobId;
        if (typeof jobId === "string" && jobId.length > 0) {
          endpoint = `/api/prepay/status?jobId=${encodeURIComponent(jobId)}`;
        }
      }
      if (!endpoint) {
        setChecks((current) => ({ ...current, [action.id]: { state: "UNKNOWN", checkedAt: Date.now() } }));
        return;
      }
      const response = await authFetch(endpoint, { method: "GET" });
      const data = await response.json().catch(() => ({}));
      const state = ["COMMITTED", "NOT_COMMITTED", "RECONCILIATION_REQUIRED", "KEY_CONFLICT"].includes(data.state)
        ? data.state as ServerCheck["state"]
        : "UNKNOWN";
      const label = data.withdrawal?.code ?? data.prepay?.jobCode ?? undefined;
      const detail = state === "COMMITTED"
        ? (data.withdrawal ? `${data.withdrawal.status} · ${data.withdrawal.amount}` : data.prepay ? data.prepay.jobCode : undefined)
        : undefined;
      setChecks((current) => ({ ...current, [action.id]: { state, label, detail, retryAllowed: data.retryAllowed !== false, checkedAt: Date.now() } }));
      if (!response.ok && state === "UNKNOWN") {
        setError(typeof data.error === "string" ? data.error : copy.syncError);
      }
    } catch {
      setError(copy.syncError);
      setChecks((current) => ({ ...current, [action.id]: { state: "UNKNOWN", checkedAt: Date.now() } }));
    } finally {
      setBusyId(null);
      refresh();
    }
  }

  async function syncNow() {
    if (!isOnline || syncing) return;
    setSyncing(true);
    setError(null);
    try {
      setSyncResult(await onSync());
    } catch {
      setError(copy.syncError);
    } finally {
      setSyncing(false);
      refresh();
    }
  }

  async function retrySafely(action: QueuedAction) {
    const check = checks[action.id];
    const path = getPath(action);
    const safeRoute = path === "/api/wallets/withdraw" || path === "/api/prepay";
    if (!isOnline || check?.state !== "NOT_COMMITTED" || !safeRoute || !action.needsReconciliation) return;
    setBusyId(action.id);
    try {
      if (!retryAfterReconciliation(action.id)) throw new Error("Queue state changed");
      setChecks((current) => {
        const next = { ...current };
        delete next[action.id];
        return next;
      });
      await onSync([action.id]);
    } catch {
      setError(copy.syncError);
    } finally {
      setBusyId(null);
      refresh();
    }
  }

  function confirmCompleted(action: QueuedAction) {
    if (checks[action.id]?.state !== "COMMITTED") return;
    dequeueAction(action.id);
    window.dispatchEvent(new Event("storage"));
    setConfirmDeleteId(null);
    setChecks((current) => {
      const next = { ...current };
      delete next[action.id];
      return next;
    });
    refresh();
  }

  function confirmCancel(action: QueuedAction) {
    if (confirmDeleteId !== action.id) return;
    dequeueAction(action.id);
    window.dispatchEvent(new Event("storage"));
    setConfirmDeleteId(null);
    setChecks((current) => {
      const next = { ...current };
      delete next[action.id];
      return next;
    });
    refresh();
  }

  return (
    <div className="flex h-full flex-col" dir={isFa ? "rtl" : "ltr"}>
      <div className="border-b border-border px-5 py-5">
        <div className="flex items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber/15 text-amber">
            <ShieldAlert className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{copy.title}</h2>
            <p className="mt-1 text-xs leading-6 text-muted-foreground">{copy.description}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${isOnline ? "bg-emerald-500/10 text-emerald-600" : "bg-amber/10 text-amber"}`}>
            {isOnline ? <Cloud className="size-3.5" /> : <CloudOff className="size-3.5" />}
            {isOnline ? copy.online : copy.offline}
          </div>
          <Button size="sm" variant="outline" onClick={syncNow} disabled={!isOnline || syncing}>
            {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {copy.refresh}
          </Button>
        </div>
        {syncResult && (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            {copy.syncDone}: {syncResult.synced} · {copy.retries}: {syncResult.failed} · {copy.status}: {syncResult.reconciliationRequired}
          </p>
        )}
        {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {waitingCount > 0 && (
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start gap-2">
              <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{copy.waitingTitle} · {waitingCount}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.waitingDescription}</p>
              </div>
            </div>
          </div>
        )}
        {reviewActions.length === 0 && waitingCount === 0 ? (
          <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-border p-6 text-center">
            <div>
              <CheckCircle2 className="mx-auto size-8 text-emerald-500" />
              <p className="mt-3 text-sm font-medium">{copy.empty}</p>
            </div>
          </div>
        ) : reviewActions.map((action) => {
          const check = checks[action.id];
          const path = getPath(action);
          const canCheck = (path === "/api/wallets/withdraw" && !!action.idempotencyKey) ||
            (path === "/api/prepay" && typeof getBody(action).jobId === "string");
          const canRetry = check?.state === "NOT_COMMITTED" &&
            (path === "/api/wallets/withdraw" || path === "/api/prepay") &&
            !!action.needsReconciliation && check?.retryAllowed !== false;
          return (
            <Card key={action.id} className="gap-0 overflow-hidden">
              <CardHeader className="gap-2 border-b border-border px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" />
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-sm">{operationLabel(action, isFa)}</CardTitle>
                    <CardDescription className="mt-1 text-xs leading-5">{copy.notConfirmed}</CardDescription>
                  </div>
                  <span className="rounded-full bg-amber/10 px-2 py-1 text-[10px] font-medium text-amber">
                    {isFa ? "نیازمند بررسی" : "Review required"}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 px-4 py-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                  <div className="col-span-2 sm:col-span-3"><p className="text-muted-foreground">{copy.resource}</p><p className="mt-1 break-all font-medium">{affectedResource(action, isFa)}</p></div>
                  <div><p className="text-muted-foreground">{copy.created}</p><p className="mt-1 font-medium">{formatDate(action.timestamp, lang)}</p></div>
                  <div><p className="text-muted-foreground">{copy.attempted}</p><p className="mt-1 font-medium">{formatDate(action.lastAttemptAt, lang)}</p></div>
                  <div><p className="text-muted-foreground">{copy.retries}</p><p className="mt-1 font-medium tabular-nums">{action.retryCount}/{action.maxRetries}</p></div>
                </div>
                <div className="rounded-lg bg-muted/50 p-3 text-xs">
                  <p className="text-muted-foreground">{copy.reference}</p>
                  <p className="mt-1 break-all font-mono text-[11px]" dir="ltr">{action.id}</p>
                  <p className="mt-2 text-muted-foreground">{copy.reason}</p>
                  <p className="mt-1 leading-5">{reasonLabel(action, isFa)}</p>
                  {action.lastStatus && <p className="mt-1 text-muted-foreground">{copy.http}: {action.lastStatus}</p>}
                </div>
                {check && (
                  <div className="rounded-lg border border-border p-3 text-xs" role="status" aria-live="polite">
                    <p className="font-semibold">{copy.status}</p>
                    <p className="mt-1 leading-5">
                      {check.state === "COMMITTED" ? copy.committed :
                       check.state === "NOT_COMMITTED" ? copy.notCommitted :
                       check.state === "RECONCILIATION_REQUIRED" ? copy.partial :
                       check.state === "KEY_CONFLICT" ? copy.keyConflict : copy.unknown}
                    </p>
                    {check.label && <p className="mt-1 font-medium">{check.label}</p>}
                    {check.detail && <p className="mt-1 text-muted-foreground">{check.detail}</p>}
                    {check.state === "NOT_COMMITTED" && check.retryAllowed === false && <p className="mt-2 text-amber">{copy.retryDisabled}</p>}
                    <p className="mt-1 text-[10px] text-muted-foreground">{formatDate(check.checkedAt, lang)}</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {canCheck && (
                    <Button size="sm" variant="outline" onClick={() => checkServer(action)} disabled={!isOnline || busyId !== null}>
                      {busyId === action.id ? <Loader2 className="size-3.5 animate-spin" /> : <SearchCheck className="size-3.5" />}
                      {busyId === action.id ? copy.checking : copy.check}
                    </Button>
                  )}
                  {check?.state === "COMMITTED" && (
                    <Button size="sm" onClick={() => confirmCompleted(action)} disabled={busyId !== null}>
                      <CheckCircle2 className="size-3.5" />{copy.markDone}
                    </Button>
                  )}
                  {canRetry && (
                    <Button size="sm" onClick={() => retrySafely(action)} disabled={busyId !== null}>
                      <RotateCcw className="size-3.5" />{copy.retry}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDeleteId(action.id)} disabled={busyId !== null}>
                    <Trash2 className="size-3.5" />{copy.cancel}
                  </Button>
                </div>
                {confirmDeleteId === action.id && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
                    <p className="text-xs leading-5">{copy.confirm}</p>
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="destructive" onClick={() => confirmCancel(action)}>{copy.yesDelete}</Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirmDeleteId(null)}>{copy.keep}</Button>
                    </div>
                  </div>
                )}
                {!canCheck && !check && <p className="text-[11px] text-muted-foreground"><CircleHelp className="mr-1 inline size-3.5" />{copy.unknown}</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <div className="border-t border-border px-5 py-3 text-[11px] leading-5 text-muted-foreground">
        <Clock3 className="mr-1 inline size-3.5" />{copy.retryNote}
      </div>
    </div>
  );
}
