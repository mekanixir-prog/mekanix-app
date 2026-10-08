"use client";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Truck, Wrench, CalendarClock, DollarSign, Loader2, ChevronRight,
  ShieldCheck, ShieldAlert, AlertTriangle, MapPin, Plus, Activity,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { api, type Vehicle, type Job } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { MekIcon, iconForMachineType } from "@/components/mek/shared/icons";
import { fmtDate, fmtRelative, toPersianDigits } from "@/lib/format";
import { toast } from "sonner";

type Schedule = {
  id: string;
  vehicleId: string;
  category: string;
  title: string;
  lastDoneDate: string | null;
  nextDueDate: string | null;
  active: boolean;
};

type VehicleStatus = "healthy" | "dueSoon" | "overdue";

function computeVehicleStatus(schedules: Schedule[]): VehicleStatus {
  if (schedules.length === 0) return "healthy";
  const now = Date.now();
  const SOON_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days
  let worst: VehicleStatus = "healthy";
  for (const s of schedules) {
    if (!s.nextDueDate) continue;
    const due = new Date(s.nextDueDate).getTime();
    if (due <= now) worst = "overdue";
    else if (due <= now + SOON_WINDOW && worst !== "overdue") worst = "dueSoon";
  }
  return worst;
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

export function CustomerFleetDashboard({ customer }: { customer: DemoUser }) {
  const { go } = useApp();
  const { t, isFa, money, lang } = useT();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);

  useEffect(() => {
    if (!customer.customer) return;
    const cid = customer.customer.id;
    api.listVehicles(cid).then(setVehicles).catch(() => setVehicles([]));
    api.listJobs({ customerId: cid }).then(setJobs).catch(() => setJobs([]));
    fetch(`/api/maintenance?customerId=${cid}`)
      .then((r) => r.json())
      .then((data) => setSchedules(Array.isArray(data) ? data : []))
      .catch(() => setSchedules([]));
  }, [customer]);

  const loading = vehicles === null || jobs === null || schedules === null;

  // Group schedules by vehicle
  const schedulesByVehicle = useMemo(() => {
    const map: Record<string, Schedule[]> = {};
    for (const s of schedules ?? []) {
      if (!map[s.vehicleId]) map[s.vehicleId] = [];
      map[s.vehicleId].push(s);
    }
    return map;
  }, [schedules]);

  // KPI: active jobs (not completed/cancelled)
  const activeJobsCount = (jobs ?? []).filter(
    (j) => j.status !== "COMPLETED" && j.status !== "CANCELLED" && j.status !== "REJECTED"
  ).length;

  // KPI: maintenance due (overdue + due soon)
  const maintenanceDueCount = (vehicles ?? []).filter((v) => {
    const status = computeVehicleStatus(schedulesByVehicle[v.id] ?? []);
    return status === "overdue" || status === "dueSoon";
  }).length;

  // KPI: total spent (30d) — sum of invoices for completed jobs in last 30 days
  const totalSpent30d = (jobs ?? [])
    .filter((j) => {
      if (!j.completedAt || !j.invoice) return false;
      const diff = Date.now() - new Date(j.completedAt).getTime();
      return diff <= 30 * 24 * 60 * 60 * 1000;
    })
    .reduce((sum, j) => sum + (j.invoice?.total != null ? Number(j.invoice.total) : 0), 0);

  // Fleet health
  const overdueVehiclesCount = (vehicles ?? []).filter((v) => {
    const status = computeVehicleStatus(schedulesByVehicle[v.id] ?? []);
    return status === "overdue";
  }).length;

  const healthLevel: "good" | "warning" | "critical" =
    overdueVehiclesCount === 0 ? "good" : overdueVehiclesCount <= Math.ceil((vehicles?.length ?? 0) / 3) ? "warning" : "critical";

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center" dir={isFa ? "rtl" : "ltr"}>
        <Loader2 className="size-6 animate-spin text-amber" />
      </div>
    );
  }

  const num = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("fleet.title")} subtitle={t("fleet.subtitle")} />

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t("fleet.totalVehicles")} value={num(vehicles?.length ?? 0)} icon={Truck} tone="blue" />
        <StatCard label={t("fleet.activeJobs")} value={num(activeJobsCount)} icon={Wrench} tone="amber" />
        <StatCard
          label={t("fleet.maintenanceDue")}
          value={num(maintenanceDueCount)}
          icon={CalendarClock}
          tone={maintenanceDueCount > 0 ? "rose" : "emerald"}
        />
        <StatCard label={t("fleet.totalSpent")} value={money(totalSpent30d)} icon={DollarSign} tone="violet" />
      </div>

      {/* Fleet health banner */}
      {vehicles && vehicles.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className={`rounded-xl border p-4 ${
            healthLevel === "good"
              ? "border-emerald-glow/30 bg-emerald-glow/5"
              : healthLevel === "warning"
              ? "border-amber/30 bg-amber/5"
              : "border-destructive/30 bg-destructive/5"
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`grid size-10 place-items-center rounded-lg border ${
                healthLevel === "good"
                  ? "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow"
                  : healthLevel === "warning"
                  ? "border-amber/30 bg-amber/10 text-amber"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {healthLevel === "good" ? <ShieldCheck className="size-5" /> : healthLevel === "warning" ? <AlertTriangle className="size-5" /> : <ShieldAlert className="size-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t("fleet.healthScore")}</p>
              <p
                className={`font-display text-sm font-semibold ${
                  healthLevel === "good"
                    ? "text-emerald-glow"
                    : healthLevel === "warning"
                    ? "text-amber"
                    : "text-destructive"
                }`}
              >
                {healthLevel === "good"
                  ? t("fleet.healthScoreGood")
                  : healthLevel === "warning"
                  ? t("fleet.healthScoreWarning")
                  : t("fleet.healthScoreCritical")}
              </p>
            </div>
            {overdueVehiclesCount > 0 && (
              <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
                {num(overdueVehiclesCount)} {isFa ? "خودرو" : "vehicles"}
              </Badge>
            )}
          </div>
        </motion.div>
      )}

      {/* Vehicle list */}
      {vehicles && vehicles.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={t("fleet.noVehicles")}
          description={t("fleet.subtitle")}
          action={
            <Button onClick={() => go("vehicles")} className="bg-amber text-black hover:bg-amber/90">
              <Plus className="mr-1.5 size-4" /> {t("fleet.addVehicle")}
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden py-0">
          {/* Header row (hidden on mobile) */}
          <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto] gap-3 border-b border-border bg-muted/30 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
            <span>{t("fleet.vehicle")}</span>
            <span>{t("fleet.status")}</span>
            <span>{t("fleet.lastService")}</span>
            <span>{t("fleet.nextService")}</span>
            <span>{t("fleet.engineHours")}</span>
            <span>{t("fleet.location")}</span>
            <span>{t("fleet.actions")}</span>
          </div>
          <div className="divide-y divide-border">
            {vehicles?.map((v, i) => {
              const vSchedules = schedulesByVehicle[v.id] ?? [];
              const status = computeVehicleStatus(vSchedules);
              const lastDone = vSchedules
                .map((s) => s.lastDoneDate)
                .filter(Boolean)
                .sort((a, b) => new Date(b!).getTime() - new Date(a!).getTime())[0] ?? null;
              const nextDue = vSchedules
                .map((s) => s.nextDueDate)
                .filter(Boolean)
                .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0] ?? null;
              const days = daysUntil(nextDue);
              return (
                <motion.div
                  key={v.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3) }}
                  className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto] md:items-center"
                >
                  {/* Vehicle */}
                  <div className="flex items-center gap-3">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
                      <MekIcon name={iconForMachineType(v.type)} className="size-4 text-amber" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {v.make} {v.model}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {isFa ? toPersianDigits(v.year) : v.year} {v.plate && `· ${isFa ? toPersianDigits(v.plate) : v.plate}`}
                      </p>
                    </div>
                  </div>

                  {/* Status */}
                  <div>
                    <StatusPill status={status} />
                  </div>

                  {/* Last service */}
                  <div className="text-[11px] text-muted-foreground">
                    {lastDone ? fmtDate(lastDone, undefined, lang) : "—"}
                  </div>

                  {/* Next service */}
                  <div className="text-[11px]">
                    {nextDue ? (
                      <span
                        className={
                          days !== null && days < 0
                            ? "font-medium text-destructive"
                            : days !== null && days <= 7
                            ? "font-medium text-amber"
                            : "text-muted-foreground"
                        }
                      >
                        {fmtDate(nextDue, undefined, lang)}
                        <span className="block text-[10px] opacity-80">{fmtRelative(nextDue, lang)}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </div>

                  {/* Engine hours */}
                  <div className="text-[11px] text-muted-foreground">
                    {v.engineHours != null ? `${isFa ? toPersianDigits(v.engineHours) : v.engineHours} ${isFa ? "ساعت" : "h"}` : "—"}
                  </div>

                  {/* Location */}
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    {v.location ? (
                      <>
                        <MapPin className="size-3 text-amber" />
                        <span className="truncate">{v.location}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>

                  {/* Actions */}
                  <div>
                    <Button variant="outline" size="sm" onClick={() => go("vehicles")} className="gap-1 text-xs">
                      {t("fleet.viewDetails")} <ChevronRight className="size-3" />
                    </Button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Live ops mini banner */}
      {vehicles && vehicles.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Activity className="size-3 text-amber" /> {isFa ? "نمای کلی" : "Overview"}
            </p>
            <p className="mt-1 font-display text-sm">
              {num(vehicles.length)} {isFa ? "خودرو" : "vehicles"} · {num(activeJobsCount)} {isFa ? "کار فعال" : "active"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <CalendarClock className="size-3 text-amber" /> {t("fleet.maintenanceDue")}
            </p>
            <p className="mt-1 font-display text-sm">
              {num(maintenanceDueCount)} {isFa ? "خودرو نیاز به سرویس دارد" : "need service"}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <DollarSign className="size-3 text-amber" /> {t("fleet.totalSpent")}
            </p>
            <p className="mt-1 font-display text-sm">{money(totalSpent30d)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: VehicleStatus }) {
  const { t } = useT();
  const map: Record<VehicleStatus, string> = {
    healthy: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
    dueSoon: "border-amber/30 bg-amber/10 text-amber",
    overdue: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  const labels: Record<VehicleStatus, string> = {
    healthy: t("fleet.healthy"),
    dueSoon: t("fleet.dueSoon"),
    overdue: t("fleet.overdue"),
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${map[status]}`}>
      <span className="size-1.5 rounded-full bg-current mk-status-pulse" />
      {labels[status]}
    </span>
  );
}
