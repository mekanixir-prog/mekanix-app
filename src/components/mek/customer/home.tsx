"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Wrench, Siren, CalendarClock, Car, History, ChevronRight, MapPin, Clock, ShieldCheck, Activity, Zap, ShieldAlert,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Vehicle, type Job } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { StatusBadge, UrgencyBadge } from "@/components/mek/shared/status-badge";
import { StatCard, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { MekIcon, iconForMachineType } from "@/components/mek/shared/icons";
import { SpecialAlertBanner } from "@/components/mek/shared/special-alert-banner";
import { fmtRelative, fmtDate, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Link as LinkIcon, CircleDot } from "lucide-react";

export function CustomerHome({ customer }: { customer: DemoUser }) {
  const { go, machineMode, auth } = useApp();
  const { t, isFa, money, type } = useT();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [activeJobs, setActiveJobs] = useState<Job[] | null>(null);
  const [history, setHistory] = useState<Job[] | null>(null);

  useEffect(() => {
    if (!customer.customer) return;
    api.listVehicles(customer.customer.id).then((v) => setVehicles(filterByMode(v, machineMode))).catch(() => setVehicles([]));
    api.listJobs({ customerId: customer.customer.id }).then((j) => {
      const filtered = filterJobsByMode(j, machineMode);
      setActiveJobs(filtered.filter((x) => x.status !== "COMPLETED" && x.status !== "CANCELLED"));
      setHistory(filtered.filter((x) => x.status === "COMPLETED").slice(0, 3));
    }).catch(() => { setActiveJobs([]); setHistory([]); });
  }, [customer, machineMode]);

  const quickActions = [
    { label: t("home.quick.requestMechanic"), desc: t("home.quick.requestDesc"), icon: Wrench, tone: "amber", view: "request-type" },
    { label: t("home.quick.emergency"), desc: t("home.quick.emergencyDesc"), icon: Siren, tone: "rose", view: "request-type", urgency: "EMERGENCY" },
    { label: t("home.quick.maintenance"), desc: t("home.quick.maintenanceDesc"), icon: CalendarClock, tone: "emerald", view: "request-type", urgency: "NORMAL" },
    { label: t("home.quick.vehicles"), desc: t("home.quick.vehiclesDesc"), icon: Car, tone: "blue", view: "vehicles" },
  ];

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      {/* Special alert banner (mechanic rejected, etc.) */}
      <SpecialAlertBanner userId={customer.id} />

      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div className="absolute inset-0 mk-grid-bg opacity-40" />
        <div className="absolute -right-20 -top-20 size-72 rounded-full bg-amber/20 blur-3xl mk-radial-fade" />
        <div className="absolute -left-10 bottom-0 size-48 rounded-full bg-emerald-glow/10 blur-3xl mk-radial-fade" />
        <div className="relative grid gap-6 p-6 sm:p-8 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-2 rounded-full border border-amber/30 bg-amber/10 px-3 py-1 text-[11px] font-medium text-amber">
              <span className="size-1.5 rounded-full bg-amber mk-status-pulse" />
              {machineMode === "heavy" ? t("mode.heavy") : t("mode.passenger")} {t("home.heroMode")} · {isFa ? toPersianDigits(vehicles?.length ?? 0) : (vehicles?.length ?? 0)} {t("home.heroMachines")}
            </motion.div>
            {auth.isGuest && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/5 px-3 py-1.5 text-[11px] text-amber">
                <ShieldAlert className="size-3.5" />
                {t("home.guestBanner")}
              </motion.div>
            )}
            <motion.h1
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="mt-4 font-display text-3xl font-bold leading-[1.05] tracking-tight sm:text-4xl lg:text-5xl"
            >
              {t("home.heroTitle1")} <br className="hidden sm:block" />
              <span className="text-amber mk-text-glow">{t("home.heroTitle2")}</span>
            </motion.h1>
            <p className="mt-3 max-w-md text-sm text-muted-foreground sm:text-base">
              {t("home.heroDesc")}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={() => go("request-type")} className="bg-amber text-black hover:bg-amber/90">
                <Wrench className="mr-1.5 size-4" /> {t("home.cta.requestMechanic")}
              </Button>
              <Button variant="outline" onClick={() => go("vehicles")}>
                <Car className="mr-1.5 size-4" /> {t("home.cta.viewFleet")}
              </Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-emerald-glow" /> {t("home.feature.verified")}</span>
              <span className="inline-flex items-center gap-1.5"><Activity className="size-3.5 text-amber" /> {t("home.feature.tracking")}</span>
              <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5 text-sky-400" /> {t("home.feature.response")}</span>
            </div>
          </div>

          {/* Live ops mini panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 }}
            className="relative rounded-xl border border-border bg-background/60 p-4 backdrop-blur"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("home.liveOps")}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-glow/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-glow">
                <span className="size-1.5 rounded-full bg-emerald-glow mk-status-pulse" /> {t("home.operational")}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MiniMetric label={t("home.metric.activeJobs")} value={activeJobs == null ? "—" : (isFa ? toPersianDigits(activeJobs.length) : activeJobs.length)} icon={Wrench} tone="amber" />
              <MiniMetric label={t("home.metric.inFleet")} value={vehicles == null ? "—" : (isFa ? toPersianDigits(vehicles.length) : vehicles.length)} icon={Car} tone="blue" />
              <MiniMetric label={t("home.metric.completed")} value={history == null ? "—" : (isFa ? toPersianDigits(history.length) : history.length)} icon={ShieldCheck} tone="emerald" />
              <MiniMetric label={t("home.metric.response")} value={isFa ? "۱۵ دقیقه" : "15m"} icon={Zap} tone="violet" />
            </div>
            <div className="mt-3 rounded-lg border border-border bg-card/60 p-2.5">
              <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{t("home.coverageZone")}</p>
              <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                <MapPin className="size-3.5 text-amber" />
                <span>{t("home.coverageArea")}</span>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Quick actions */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {quickActions.map((a, i) => (
          <motion.button
            key={a.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            whileHover={{ y: -2 }}
            onClick={() => go(a.view, a.urgency ? { urgency: a.urgency } : undefined)}
            className="group relative overflow-hidden rounded-xl border border-border bg-card p-4 text-left mk-card-hover hover:border-amber/40"
          >
            <div className={`grid size-10 place-items-center rounded-lg border ${toneBorder(a.tone)} ${toneBg(a.tone)}`}>
              <a.icon className={`size-5 ${toneText(a.tone)}`} />
            </div>
            <p className="mt-3 font-display text-sm font-semibold">{a.label}</p>
            <p className="text-[11px] text-muted-foreground">{a.desc}</p>
            <ChevronRight className="absolute right-3 top-3 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </motion.button>
        ))}
      </section>

      {/* Active jobs */}
      <section>
        <SectionHeader
          title={t("home.section.activeCalls")}
          subtitle={t("home.section.activeCallsSub")}
          action={<Button variant="ghost" size="sm" onClick={() => go("service-history")}>{t("home.section.history")} <ChevronRight className="size-3.5" /></Button>}
        />
        <div className="mt-3">
          {activeJobs === null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="h-28 rounded-xl bg-muted/60 mk-shimmer" />)}
            </div>
          ) : activeJobs.length === 0 ? (
            <EmptyState icon={Wrench} title={t("home.empty.activeJobs")} description={t("home.empty.activeJobsDesc")} action={<Button onClick={() => go("request-type")} className="bg-amber text-black hover:bg-amber/90"><Wrench className="mr-1.5 size-4" />{t("home.quick.requestMechanic")}</Button>} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {activeJobs.slice(0, 4).map((job) => (
                <ActiveJobCard key={job.id} job={job} onClick={() => go("track", { jobId: job.id })} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Fleet snapshot + recent history */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div>
          <SectionHeader title={t("home.section.yourFleet")} action={<Button variant="ghost" size="sm" onClick={() => go("vehicles")}>{t("home.section.manage")} <ChevronRight className="size-3.5" /></Button>} />
          <div className="mt-3">
            {vehicles === null ? (
              <div className="h-28 rounded-xl bg-muted/60 mk-shimmer" />
            ) : vehicles.length === 0 ? (
              <EmptyState icon={Car} title={t("home.empty.vehicles")} description={t("home.empty.vehiclesDesc")} action={<Button onClick={() => go("vehicles")} variant="outline" size="sm"><Car className="mr-1.5 size-4" />{t("home.empty.addVehicle")}</Button>} />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {vehicles.slice(0, 4).map((v) => (
                  <button key={v.id} onClick={() => go("vehicles")} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left mk-card-hover hover:border-amber/40">
                    <div className="grid size-9 place-items-center rounded-lg border border-border bg-background">
                      <MekIcon name={iconForMachineType(v.type)} className="size-4 text-amber" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{v.make} {v.model}</p>
                      <p className="text-[11px] text-muted-foreground">{type(v.type)} · {v.year}</p>
                    </div>
                    {v.plate && <span className="font-mono text-[9px] text-muted-foreground">{v.plate}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div>
          <SectionHeader title={t("home.section.recentHistory")} action={<Button variant="ghost" size="sm" onClick={() => go("service-history")}>{t("home.section.all")} <ChevronRight className="size-3.5" /></Button>} />
          <div className="mt-3">
            {history === null ? (
              <div className="h-28 rounded-xl bg-muted/60 mk-shimmer" />
            ) : history.length === 0 ? (
              <EmptyState icon={History} title={t("home.empty.history")} description={t("home.empty.historyDesc")} />
            ) : (
              <div className="space-y-2">
                {history.map((job) => (
                  <button key={job.id} onClick={() => go("service-history")} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left mk-card-hover hover:border-amber/40">
                    <div className="grid size-9 place-items-center rounded-lg border border-emerald-glow/30 bg-emerald-glow/10">
                      <ShieldCheck className="size-4 text-emerald-glow" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{job.request.title}</p>
                      <p className="text-[11px] text-muted-foreground">{job.request.vehicle.make} {job.request.vehicle.model} · {fmtDate(job.completedAt ?? job.createdAt, undefined, isFa ? "fa" : "en")}</p>
                    </div>
                    {job.invoice && <span className="font-mono text-xs text-amber">{money(Number(job.invoice.total))}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MiniMetric({ label, value, icon: Icon, tone }: { label: string; value: any; icon: any; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className={`size-3 ${toneText(tone)}`} />
        <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <p className={`mt-1 font-display text-lg font-semibold ${toneText(tone)}`}>{value}</p>
    </div>
  );
}

function ActiveJobCard({ job, onClick }: { job: Job; onClick: () => void }) {
  const { t, isFa } = useT();
  return (
    <button onClick={onClick} className="group relative overflow-hidden rounded-xl border border-border bg-card p-4 text-left mk-card-hover hover:border-amber/40">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code}</span>
            <UrgencyBadge urgency={job.request.urgency} />
          </div>
          <p className="mt-1 truncate font-display text-sm font-semibold">{job.request.title}</p>
          <p className="text-[11px] text-muted-foreground">{job.request.vehicle.make} {job.request.vehicle.model}</p>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3 text-amber" /> {job.request.vehicle.location ?? t("home.onSite")}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3 text-amber" /> {fmtRelative(job.updatedAt, isFa ? "fa" : "en")}
        </span>
      </div>
    </button>
  );
}

function toneText(t: string) {
  return { amber: "text-amber", rose: "text-destructive", emerald: "text-emerald-glow", blue: "text-sky-400", violet: "text-violet-400" }[t] ?? "text-foreground";
}
function toneBg(t: string) {
  return { amber: "bg-amber/10", rose: "bg-destructive/10", emerald: "bg-emerald-glow/10", blue: "bg-sky-500/10", violet: "bg-violet-500/10" }[t] ?? "bg-muted";
}
function toneBorder(t: string) {
  return { amber: "border-amber/30", rose: "border-destructive/30", emerald: "border-emerald-glow/30", blue: "border-sky-500/30", violet: "border-violet-500/30" }[t] ?? "border-border";
}

// ─── Mode filtering helpers (shared across customer views) ───
import { typesForMode, type MachineMode } from "@/lib/constants";

export function filterByMode<T extends { type: string }>(items: T[], mode: MachineMode): T[] {
  const types = typesForMode(mode);
  return items.filter((i) => types.includes(i.type));
}

export function filterJobsByMode(jobs: Job[], mode: MachineMode): Job[] {
  const types = typesForMode(mode);
  return jobs.filter((j) => types.includes(j.request.vehicle.type));
}
