"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity, Wrench, DollarSign, Clock, Star, TrendingUp,
} from "lucide-react";
import { api, type DashboardStats } from "@/lib/api";
import { StatCard, EmptyState, LoadingBlock } from "@/components/mek/shared/primitives";
import { RevenueAreaChart, StatusBarChart, CategoryPieChart, SatisfactionRadial } from "@/components/mek/shared/charts";
import { MapView, type MapPoint } from "@/components/mek/shared/map-view";
import { fmtRelative, pct, toPersianDigits } from "@/lib/format";
import { MekIcon, iconForCategory } from "@/components/mek/shared/icons";
import { StatusBadge } from "@/components/mek/shared/status-badge";
import { useT } from "@/lib/use-t";

export function AdminOverview() {
  const { t, isFa, money, lang } = useT();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [techs, setTechs] = useState<any[]>([]);

  useEffect(() => {
    api.dashboardStats().then(setStats).catch(() => {});
    api.adminList("technicians").then(setTechs).catch(() => {});
  }, []);

  if (!stats) return <LoadingBlock rows={4} />;

  const techPoints: MapPoint[] = techs
    .filter((x) => x.lat && x.lng)
    .slice(0, 12)
    .map((x) => ({
      id: x.id,
      lat: x.lat,
      lng: x.lng,
      kind: x.status === "ON_JOB" ? "active-job" : "technician",
      label: x.user.name,
    }));

  const fmtNum = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t("admin.overview.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("admin.overview.subtitle")}</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-glow/30 bg-emerald-glow/10 px-3 py-1 text-[11px] font-medium text-emerald-glow">
          <span className="size-1.5 rounded-full bg-emerald-glow mk-status-pulse" /> {t("admin.overview.live")}
        </span>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard label={t("admin.overview.kpi.activeRequests")} value={fmtNum(stats.kpis.activeRequests)} icon={Activity} tone="amber" />
        <StatCard label={t("admin.overview.kpi.techsOnline")} value={fmtNum(stats.kpis.techniciansOnline)} icon={Wrench} tone="emerald" />
        <StatCard label={t("admin.overview.kpi.jobsInProgress")} value={fmtNum(stats.kpis.jobsInProgress)} icon={TrendingUp} tone="violet" />
        <StatCard label={t("admin.overview.kpi.completed30")} value={fmtNum(stats.kpis.completedJobs30d)} icon={Activity} tone="blue" />
        <StatCard label={t("admin.overview.kpi.revenue30")} value={money(stats.kpis.revenue30d)} icon={DollarSign} tone="amber" />
        <StatCard label={t("admin.overview.kpi.avgResponse")} value={t("admin.overview.kpiAvgResponseSuffix").replace("{n}", fmtNum(stats.kpis.avgResponseMins))} icon={Clock} tone="emerald" />
        <StatCard label={t("admin.overview.kpi.satisfaction")} value={t("admin.overview.kpiSatisfactionSuffix").replace("{n}", fmtNum(stats.kpis.customerSatisfaction))} icon={Star} tone="violet" />
      </div>

      {/* Revenue + status */}
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold">{t("admin.overview.revenue")}</h3>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-amber" /> {t("tech.earnings.earned")}</span>
            </div>
          </div>
          <RevenueAreaChart data={stats.revenueSeries} height={220} className="mt-3" lang={lang} />
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-display text-sm font-semibold">{t("admin.overview.statusBreakdown")}</h3>
          <StatusBarChart data={stats.statusBreakdown} height={220} className="mt-3" />
        </div>
      </div>

      {/* Categories + satisfaction + map */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-display text-sm font-semibold">{t("admin.overview.categories")}</h3>
          <CategoryPieChart data={stats.categoryBreakdown} height={200} className="mt-3" />
          <div className="mt-3 space-y-1">
            {stats.categoryBreakdown.slice(0, 5).map((c) => (
              <div key={c.category} className="flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 capitalize">
                  <MekIcon name={iconForCategory(c.category)} className="size-3 text-amber" />
                  {t(`cat.${c.category}`, c.category.replace("-", " "))}
                </span>
                <span className="text-muted-foreground">{fmtNum(c.count)} · {money(c.revenue)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-display text-sm font-semibold">{t("admin.overview.satisfaction")}</h3>
          <div className="mt-3 grid place-items-center">
            <SatisfactionRadial value={stats.kpis.customerSatisfaction} size={140} lang={lang} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-[11px]">
            <div className="rounded-lg border border-border bg-background p-2">
              <p className="font-display text-base font-bold text-emerald-glow">{t("admin.overview.kpiPositivePct").replace("{n}", fmtNum(pct(Math.round(stats.kpis.customerSatisfaction * 20), 100)))}</p>
              <p className="text-muted-foreground">{t("admin.overview.positive")}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-2">
              <p className="font-display text-base font-bold text-amber">{fmtNum(stats.kpis.completedJobs30d)}</p>
              <p className="text-muted-foreground">{t("admin.overview.completed30d")}</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-display text-sm font-semibold">{t("admin.overview.geoActivity")}</h3>
          <MapView points={techPoints} height={220} showGrid />
          <p className="mt-2 text-[11px] text-muted-foreground">{t("admin.overview.techsActive").replace("{n}", fmtNum(techPoints.length))}</p>
        </div>
      </div>

      {/* Tech performance + recent activity */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border p-4">
            <h3 className="font-display text-sm font-semibold">{t("admin.overview.techPerformance")}</h3>
            <span className="text-[11px] text-muted-foreground">{t("admin.overview.topByRevenue")}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t("admin.overview.col.technician")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("admin.overview.col.jobs")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("admin.overview.col.rating")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("admin.overview.col.revenue")}</th>
                </tr>
              </thead>
              <tbody>
                {stats.techPerformance.slice(0, 8).map((tp) => {
                  const tech = techs.find((x) => x.user.name === tp.name);
                  return (
                    <tr key={tp.name} className="border-t border-border hover:bg-muted/30">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="grid size-7 place-items-center overflow-hidden rounded-full border border-border bg-muted">
                            {tech?.user?.avatar ? <img src={tech.user.avatar} alt="" className="size-full object-cover" /> : <span className="text-[10px]">{tp.name[0]}</span>}
                          </div>
                          <span className="font-medium">{tp.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(tp.jobs)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1"><Star className="size-3 fill-amber text-amber" />{isFa ? toPersianDigits(tp.rating.toFixed(1)) : tp.rating.toFixed(1)}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-amber tabular-nums">{money(tp.revenue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border p-4">
            <h3 className="font-display text-sm font-semibold">{t("admin.overview.recentActivity")}</h3>
            <Activity className="size-4 text-amber" />
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {stats.recentActivity.length === 0 ? (
              <EmptyState icon={Activity} title={t("admin.overview.noActivity")} />
            ) : (
              stats.recentActivity.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.02 }}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/30"
                >
                  <StatusBadge status={a.tone} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{a.label}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{a.sub}</p>
                  </div>
                  <span className="font-mono text-[9px] text-muted-foreground">{fmtRelative(a.ts, lang)}</span>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
