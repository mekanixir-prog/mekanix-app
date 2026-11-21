"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Heart, Wrench, CalendarClock, FileText, Shield, TrendingUp,
  ChevronLeft, Loader2, Activity, Clock, AlertCircle, CheckCircle2,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";

type CareData = {
  vehicle: { id: string; make: string; model: string; year: number; currentMileage: number };
  healthScore: number;
  nextService: any;
  scheduleItems: any[];
  recommendations: any[];
  healthReport: any;
  recentServices: any[];
  reminders: any[];
};

export function CareDashboard({ customer }: { customer: DemoUser }) {
  const { go, params } = useApp();
  const { t, isFa, money } = useT();
  const vehicleId = params.vehicleId;
  const [data, setData] = useState<CareData | null>(null);
  const [loading, setLoading] = useState(!!vehicleId);

  useEffect(() => {
    if (!vehicleId) return;
    let cancelled = false;
    fetch(`/api/care/vehicles/${vehicleId}/maintenance`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("mekanix-token")}` },
    })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && !d.error) setData(d); })
      .catch(() => toast.error("خطا در بارگذاری داده"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vehicleId]);

  if (loading) {
    return (
      <div className="grid h-64 place-items-center">
        <Loader2 className="size-8 animate-spin text-amber" />
      </div>
    );
  }

  if (!vehicleId) {
    return (
      <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
        <h1 className="text-2xl font-bold">MEKANIX CARE</h1>
        <p className="text-muted-foreground">برای مشاهده مراقبت خودرو، ابتدا یک خودرو را انتخاب کنید.</p>
        <Button onClick={() => go("vehicles")} className="bg-amber text-black hover:bg-amber/90">
          انتخاب خودرو
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
        <h1 className="text-2xl font-bold">MEKANIX CARE</h1>
        <p className="text-muted-foreground">داده‌ای یافت نشد.</p>
      </div>
    );
  }

  const { vehicle, healthScore, nextService, recommendations, recentServices, reminders } = data;
  const healthColor = healthScore >= 85 ? "text-emerald-glow" : healthScore >= 60 ? "text-amber" : "text-destructive";
  const healthBg = healthScore >= 85 ? "bg-emerald-glow/10" : healthScore >= 60 ? "bg-amber/10" : "bg-destructive/10";

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => go("vehicles")} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className={`size-5 ${isFa ? "rotate-180" : ""}`} />
        </button>
        <div>
          <h1 className="text-2xl font-bold">MEKANIX CARE</h1>
          <p className="text-sm text-muted-foreground">
            {vehicle.make} {vehicle.model} · {isFa ? toPersianDigits(vehicle.year) : vehicle.year}
          </p>
        </div>
      </div>

      {/* Vehicle Card with Health Score */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-2xl border border-border bg-card p-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{isFa ? "سلامت خودرو" : "Vehicle Health"}</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className={`font-display text-5xl font-bold ${healthColor}`}>
                {isFa ? toPersianDigits(healthScore) : healthScore}%
              </span>
            </div>
          </div>
          <div className={`grid size-20 place-items-center rounded-full ${healthBg}`}>
            <Heart className={`size-10 ${healthColor}`} />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {isFa ? "کیلومتر فعلی:" : "Mileage:"} <span className="font-medium text-foreground">{isFa ? toPersianDigits(vehicle.currentMileage.toLocaleString()) : vehicle.currentMileage.toLocaleString()} km</span>
          </span>
        </div>
      </motion.div>

      {/* Next Service Alert */}
      {nextService && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-xl border border-amber/30 bg-amber/5 p-4"
        >
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg bg-amber/10">
              <Clock className="size-5 text-amber" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">{isFa ? "سرویس بعدی" : "Next Service"}</p>
              <p className="text-xs text-muted-foreground">
                {nextService.title || nextService.category || (isFa ? "سرویس دوره‌ای" : "Periodic Service")}
                {nextService.kmRemaining != null && (
                  <span className="ms-2">· {isFa ? toPersianDigits(Math.abs(nextService.kmRemaining).toLocaleString()) : Math.abs(nextService.kmRemaining).toLocaleString()} km {nextService.kmRemaining > 0 ? (isFa ? "باقی" : "remaining") : (isFa ? "گذشته" : "overdue")}</span>
                )}
              </p>
            </div>
            <Button size="sm" className="bg-amber text-black hover:bg-amber/90" onClick={() => go("care-packages", { vehicleId })}>
              {isFa ? "رزرو سرویس" : "Book Service"}
            </Button>
          </div>
        </motion.div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickAction icon={Wrench} label={isFa ? "رزرو سرویس" : "Book Service"} onClick={() => go("care-packages", { vehicleId })} />
        <QuickAction icon={Activity} label={isFa ? "گزارش سلامت" : "Health Report"} onClick={() => go("care-health", { vehicleId })} />
        <QuickAction icon={FileText} label={isFa ? "تاریخچه" : "History"} onClick={() => go("care-history", { vehicleId })} />
        <QuickAction icon={Shield} label={isFa ? "گارانتی" : "Warranty"} onClick={() => go("care-warranty", { vehicleId })} />
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {isFa ? "پیشنهادات سرویس" : "Service Recommendations"}
          </h2>
          <div className="space-y-2">
            {recommendations.slice(0, 5).map((rec, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: isFa ? 12 : -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.15 + i * 0.05 }}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className={`grid size-8 place-items-center rounded-lg ${getPriorityColor(rec.priority)}`}>
                  {getPriorityIcon(rec.priority)}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">{getCategoryLabel(rec.category, isFa)}</p>
                  {rec.kmRemaining != null && (
                    <p className="text-[11px] text-muted-foreground">
                      {rec.kmRemaining > 0
                        ? (isFa ? `${toPersianDigits(rec.kmRemaining.toLocaleString())} کیلومتر باقی مانده` : `${rec.kmRemaining.toLocaleString()} km remaining`)
                        : (isFa ? `${toPersianDigits(Math.abs(rec.kmRemaining).toLocaleString())} کیلومتر گذشته` : `${Math.abs(rec.kmRemaining).toLocaleString()} km overdue`)
                      }
                    </p>
                  )}
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${getPriorityBadge(rec.priority)}`}>
                  {getPriorityLabel(rec.priority, isFa)}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Services */}
      {recentServices.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {isFa ? "سرویس‌های اخیر" : "Recent Services"}
          </h2>
          <div className="space-y-2">
            {recentServices.map((svc, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                <CheckCircle2 className="size-4 text-emerald-glow shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{svc.code}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(svc.createdAt).toLocaleDateString(isFa ? "fa-IR" : "en-US")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reminders */}
      {reminders.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {isFa ? "یادآوری‌ها" : "Reminders"}
          </h2>
          <div className="space-y-2">
            {reminders.map((rem, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                <CalendarClock className="size-4 text-amber shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{rem.title}</p>
                  {rem.dueDate && (
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(rem.dueDate).toLocaleDateString(isFa ? "fa-IR" : "en-US")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-amber/40 hover:bg-amber/5"
    >
      <Icon className="size-5 text-amber" />
      <span className="text-[11px] font-medium text-center">{label}</span>
    </button>
  );
}

function getPriorityColor(priority: string) {
  switch (priority) {
    case "REQUIRED": return "bg-red-100 text-red-600 dark:bg-red-500/10 dark:text-red-400";
    case "RECOMMENDED": return "bg-amber-100 text-amber-600 dark:bg-amber/10 dark:text-amber";
    case "URGENT": return "bg-red-100 text-red-600 dark:bg-red-500/10 dark:text-red-400";
    case "CONDITION_BASED": return "bg-sky-100 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400";
    default: return "bg-muted text-muted-foreground";
  }
}

function getPriorityIcon(priority: string) {
  switch (priority) {
    case "REQUIRED":
    case "URGENT":
      return <AlertCircle className="size-4" />;
    default:
      return <CheckCircle2 className="size-4" />;
  }
}

function getPriorityBadge(priority: string) {
  switch (priority) {
    case "REQUIRED": return "bg-red-500/15 text-red-500";
    case "URGENT": return "bg-red-500/15 text-red-500";
    case "RECOMMENDED": return "bg-amber/15 text-amber";
    case "CONDITION_BASED": return "bg-sky-500/15 text-sky-500";
    default: return "bg-muted text-muted-foreground";
  }
}

function getPriorityLabel(priority: string, isFa: boolean) {
  const labels: Record<string, { fa: string; en: string }> = {
    REQUIRED: { fa: "ضروری", en: "Required" },
    RECOMMENDED: { fa: "پیشنهادی", en: "Recommended" },
    URGENT: { fa: "فوری", en: "Urgent" },
    CONDITION_BASED: { fa: "وابسته به وضعیت", en: "Condition Based" },
    MONITOR: { fa: "پایش", en: "Monitor" },
  };
  return labels[priority]?.[isFa ? "fa" : "en"] || priority;
}

function getCategoryLabel(category: string, isFa: boolean) {
  const labels: Record<string, { fa: string; en: string }> = {
    oil: { fa: "تعویض روغن موتور", en: "Oil Change" },
    filter: { fa: "تعویض فیلتر", en: "Filter Replacement" },
    brake: { fa: "بررسی ترمز", en: "Brake Inspection" },
    battery: { fa: "بررسی باتری", en: "Battery Check" },
    tire: { fa: "بررسی لاستیک", en: "Tire Inspection" },
    cooling: { fa: "سیستم خنک‌کننده", en: "Cooling System" },
    belt: { fa: "تسمه‌ها", en: "Belts" },
    inspection: { fa: "بازرسی دوره‌ای", en: "Periodic Inspection" },
  };
  return labels[category]?.[isFa ? "fa" : "en"] || category;
}
