"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, Loader2, CheckCircle2, Clock, MapPin, Package, AlertCircle, FileText, Shield } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";
import { formatTomanFromIrr } from "@/lib/money/irr";

export function CareDetail() {
  const { params, back, go } = useApp();
  const { isFa } = useT();
  const locale = isFa ? "fa-IR" : "en-US";
  const moneyIrr = (value: unknown) => {
    const amount = safeInteger(value);
    return amount === null ? "—" : `${formatTomanFromIrr(amount, locale)} ${isFa ? "تومان" : "Toman"}`;
  };
  const [booking, setBooking] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.bookingId) return;
    const token = localStorage.getItem("mekanix-token");
    fetch(`/api/care/bookings/${params.bookingId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => { if (!d.error) setBooking(d); })
      .catch(() => toast.error("Error"))
      .finally(() => setLoading(false));
  }, [params.bookingId]);

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!booking) return <div className="p-6">Booking not found</div>;

  const timeline = booking.timeline || [];
  const findings = booking.findings || [];
  const approvals = booking.approvals || [];
  const pendingApprovals = approvals.filter((a: any) => a.status === "PROPOSED");

  async function handleApprove(approvalId: string) {
    const token = localStorage.getItem("mekanix-token");
    try {
      const response = await fetch(`/api/care/bookings/${params.bookingId}/approve-extra`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ approvalId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(result.error ?? (isFa ? "تأیید پیشنهاد انجام نشد" : "The proposal could not be approved"));
        return;
      }
      toast.success(isFa ? "تأیید شد" : "Approved");
      setLoading(true);
      const refreshed = await fetch(`/api/care/bookings/${params.bookingId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await refreshed.json();
      if (refreshed.ok && !data.error) setBooking(data);
      else toast.error(data.error ?? (isFa ? "به‌روزرسانی سفارش ناموفق بود" : "Could not refresh the booking"));
    } catch {
      toast.error(isFa ? "ارتباط با سرور ناموفق بود" : "Server connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReject(approvalId: string) {
    const token = localStorage.getItem("mekanix-token");
    try {
      const response = await fetch(`/api/care/bookings/${params.bookingId}/reject-extra`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ approvalId }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(result.error ?? (isFa ? "رد پیشنهاد انجام نشد" : "The proposal could not be rejected"));
        return;
      }
      toast.success(isFa ? "رد شد" : "Rejected");
      setLoading(true);
      const refreshed = await fetch(`/api/care/bookings/${params.bookingId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await refreshed.json();
      if (refreshed.ok && !data.error) setBooking(data);
      else toast.error(data.error ?? (isFa ? "به‌روزرسانی سفارش ناموفق بود" : "Could not refresh the booking"));
    } catch {
      toast.error(isFa ? "ارتباط با سرور ناموفق بود" : "Server connection failed");
    } finally {
      setLoading(false);
    }
  }

  const statusLabels: Record<string, { fa: string; en: string }> = {
    REQUESTED: { fa: "در انتظار", en: "Requested" },
    ASSIGNED: { fa: "تخصیص یافت", en: "Assigned" },
    EN_ROUTE: { fa: "در مسیر", en: "En Route" },
    ARRIVED: { fa: "رسید", en: "Arrived" },
    INSPECTING: { fa: "در حال بازرسی", en: "Inspecting" },
    WAITING_CUSTOMER_APPROVAL: { fa: "منتظر تأیید شما", en: "Awaiting Approval" },
    COMPLETED: { fa: "تکمیل شد", en: "Completed" },
    CANCELLED: { fa: "لغو شد", en: "Cancelled" },
  };
  const st = statusLabels[booking.status] || { fa: booking.status, en: booking.status };

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3">
        <button onClick={back} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className={`size-5 ${isFa ? "rotate-180" : ""}`} />
        </button>
        <div>
          <h1 className="text-xl font-bold">{booking.code}</h1>
          <p className="text-sm text-muted-foreground">{isFa ? st.fa : st.en}</p>
        </div>
      </div>

      {/* Pending approvals — Extra Cost */}
      {pendingApprovals.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
          <h2 className="text-sm font-semibold text-amber">{isFa ? "پیشنهاد هزینه اضافه" : "Extra Cost Proposal"}</h2>
          {pendingApprovals.map((ap: any) => (
            <div key={ap.id} className="rounded-xl border border-amber/30 bg-amber/5 p-4">
              <p className="font-medium">{ap.proposedItem}</p>
              {ap.description && <p className="mt-1 text-xs text-muted-foreground">{ap.description}</p>}
              {ap.partName && <p className="mt-1 text-xs">قطعه: {ap.partName} {ap.partBrand && `(${ap.partBrand})`}</p>}
              <div className="mt-2 flex items-center justify-between">
                <div className="text-sm">
                  <span className="text-muted-foreground">{isFa ? "قطعه:" : "Part:"} </span>
                  <span className="font-medium">{moneyIrr(ap.partPrice == null ? null : Number(ap.partPrice) * Number(ap.quantity))}</span>
                  <span className="ms-3 text-muted-foreground">{isFa ? "اجرت:" : "Labor:"} </span>
                  <span className="font-medium">{moneyIrr(ap.laborPrice)}</span>
                </div>
                <span className="font-display text-lg font-bold text-amber">{moneyIrr(ap.totalPrice)}</span>
              </div>
              {ap.financialUnitStatus !== "VERIFIED_IRR" && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" role="status">
                  {isFa
                    ? "مبلغ این پیشنهاد هنوز به ریال تطبیق داده نشده است؛ تأیید آن تا زمان بررسی مالی غیرفعال است."
                    : "This proposal's amount has not been verified as IRR; approval is disabled pending reconciliation."}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={ap.financialUnitStatus !== "VERIFIED_IRR" || ap.totalPrice == null} onClick={() => handleApprove(ap.id)} className="bg-emerald-600 text-white hover:bg-emerald-700">
                  <CheckCircle2 className="me-1.5 size-3.5" /> {isFa ? "تأیید" : "Approve"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleReject(ap.id)} className="text-red-500 hover:bg-red-500/10">
                  {isFa ? "رد" : "Reject"}
                </Button>
              </div>
            </div>
          ))}
        </motion.div>
      )}

      {/* Booking info */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <Package className="size-4 text-amber" />
          <h3 className="font-bold">{booking.package?.nameFa || booking.package?.name || (isFa ? "سرویس دوره‌ای" : "Periodic Service")}</h3>
        </div>
        <div className="space-y-1.5 text-sm">
          <InfoRow icon={MapPin} label={isFa ? "محل" : "Location"} value={booking.location} />
          {booking.date && <InfoRow icon={Clock} label={isFa ? "تاریخ" : "Date"} value={new Date(booking.date).toLocaleDateString(isFa ? "fa-IR" : "en-US")} />}
          {booking.timeWindow && <InfoRow icon={Clock} label={isFa ? "بازه" : "Time"} value={booking.timeWindow} />}
        </div>
        {/* Pricing */}
        {booking.pricing && (
          <div className="border-t border-border pt-3 space-y-1.5">
            {booking.pricing.financialUnitStatus === "VERIFIED_IRR" && booking.pricing.currency === "IRR" ? <>
              <PriceLine label={isFa ? "دستمزد ثابت" : "Fixed labor"} amount={booking.pricing.laborPrice} money={moneyIrr} />
              <PriceLine label={isFa ? "اعزام" : "Dispatch"} amount={booking.pricing.visitPrice} money={moneyIrr} />
              <PriceLine label={isFa ? "بازدید و عیب‌یابی" : "Inspection"} amount={booking.pricing.inspectionPrice} money={moneyIrr} />
              {(safeInteger(booking.pricing.emergencyPrice) ?? 0) > 0 && <PriceLine label={isFa ? "هزینه فوریت" : "Emergency surcharge"} amount={booking.pricing.emergencyPrice} money={moneyIrr} />}
              <PriceLine label={isFa ? "قطعات" : "Parts"} amount={booking.pricing.partsPrice} money={moneyIrr} muted />
              {(safeInteger(booking.pricing.discount) ?? 0) > 0 && <PriceLine label={isFa ? "تخفیف" : "Discount"} amount={booking.pricing.discount} money={moneyIrr} muted />}
              {(safeInteger(booking.pricing.taxTotal) ?? 0) > 0 && <PriceLine label={isFa ? "مالیات" : "Tax"} amount={booking.pricing.taxTotal} money={moneyIrr} muted />}
              <div className="flex items-center justify-between border-t border-border pt-2">
                <span className="font-bold">{isFa ? "مبلغ نهایی" : "Total"}</span>
                <span className="font-display text-lg font-bold text-amber">{moneyIrr(booking.pricing.total)}</span>
              </div>
            </> : <p className="rounded-lg bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
              {isFa ? "واحد پول این سابقه مالی هنوز تأیید نشده است؛ مبلغ تا زمان تطبیق نمایش داده نمی‌شود." : "The currency provenance for this historical amount is not verified; it is hidden until reconciled."}
            </p>}
          </div>
        )}
      </div>

      {/* Findings */}
      {findings.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{isFa ? "یافته‌ها" : "Findings"}</h2>
          {findings.map((f: any) => (
            <div key={f.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <AlertCircle className={`size-4 ${f.severity === "CRITICAL" || f.severity === "HIGH" ? "text-red-500" : "text-amber"}`} />
                <span className="font-medium text-sm">{f.title}</span>
              </div>
              {f.description && <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Timeline */}
      {timeline.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{isFa ? "تایم‌لاین" : "Timeline"}</h2>
          <div className="space-y-2">
            {timeline.map((ev: any, i: number) => (
              <div key={i} className="flex items-start gap-3">
                <div className="mt-1 grid size-6 place-items-center rounded-full bg-amber/10">
                  <CheckCircle2 className="size-3 text-amber" />
                </div>
                <div>
                  <p className="text-sm font-medium">{ev.eventType.replace(/_/g, " ")}</p>
                  <p className="text-[11px] text-muted-foreground">{new Date(ev.timestamp).toLocaleString(isFa ? "fa-IR" : "en-US")}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Health Report */}
      {booking.healthReport && (
        <div className="rounded-xl border border-emerald-glow/30 bg-emerald-glow/5 p-5">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-emerald-glow" />
            <h3 className="font-bold">{isFa ? "گزارش سلامت" : "Health Report"}</h3>
          </div>
          <p className="mt-2 text-3xl font-bold text-emerald-glow">{isFa ? toPersianDigits(booking.healthReport.overallScore) : booking.healthReport.overallScore}%</p>
        </div>
      )}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value || "—"}</span>
    </div>
  );
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+(?:\.0+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function PriceLine({ label, amount, money, muted }: { label: string; amount: unknown; money: (n: unknown) => string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted-foreground" : ""}>{label}</span>
      <span className={`tabular-nums ${muted ? "text-muted-foreground" : "font-medium"}`}>{money(amount)}</span>
    </div>
  );
}
