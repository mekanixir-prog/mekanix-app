"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { History, ChevronRight, Loader2, ShieldCheck, Wrench } from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/use-t";
import { api, type Job } from "@/lib/api";
import { MekIcon, iconForMachineType } from "@/components/mek/shared/icons";
import { StatusBadge } from "@/components/mek/shared/status-badge";
import { EmptyState, SectionHeader } from "@/components/mek/shared/primitives";
import { fmtDate, fmtMoney, fmtRelative, toPersianDigits } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export function CustomerHistory({ customer }: { customer: DemoUser }) {
  const { go } = useApp();
  const { t, isFa, money } = useT();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!customer.customer) return;
    api.listJobs({ customerId: customer.customer.id }).then(setJobs).catch(() => setJobs([]));
  }, [customer]);

  const filtered = (jobs ?? []).filter((j) => {
    if (filter === "completed" && j.status !== "COMPLETED") return false;
    if (filter === "active" && (j.status === "COMPLETED" || j.status === "CANCELLED")) return false;
    if (filter === "cancelled" && j.status !== "CANCELLED") return false;
    if (query && !(`${j.request.title} ${j.request.vehicle.make} ${j.request.vehicle.model} ${j.code}`.toLowerCase().includes(query.toLowerCase()))) return false;
    return true;
  });

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader
        title={t("history.title")}
        subtitle={t("history.subtitle")}
        action={<Button onClick={() => go("request-type")} className="bg-amber text-black hover:bg-amber/90"><Wrench className="mr-1.5 size-4" /> {t("history.newRequest")}</Button>}
      />

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("history.searchPlaceholder")} className="sm:max-w-xs" />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("history.allJobs")}</SelectItem>
            <SelectItem value="active">{t("history.active")}</SelectItem>
            <SelectItem value="completed">{t("history.completed")}</SelectItem>
            <SelectItem value="cancelled">{t("history.cancelled")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {jobs === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-20 rounded-xl bg-muted/60 mk-shimmer" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={History} title={t("history.noJobs")} description={t("history.noJobsDesc")} action={<Button onClick={() => go("request-type")} className="bg-amber text-black hover:bg-amber/90">{t("history.newRequest")}</Button>} />
      ) : (
        <div className="space-y-2">
          {filtered.map((job, i) => (
            <motion.button
              key={job.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              onClick={() => go(job.status === "COMPLETED" ? "completion" : "track", { jobId: job.id })}
              className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left mk-card-hover hover:border-amber/40"
            >
              <div className="grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-background">
                <MekIcon name={iconForMachineType(job.request.vehicle.type)} className="size-5 text-amber" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code}</span>
                  <StatusBadge status={job.status} />
                </div>
                <p className="mt-0.5 truncate text-sm font-medium">{job.request.title}</p>
                <p className="text-[11px] text-muted-foreground">{job.request.vehicle.make} {job.request.vehicle.model} · {fmtDate(job.completedAt ?? job.createdAt, undefined, isFa ? "fa" : "en")}</p>
              </div>
              {job.invoice && (
                <div className="hidden text-right sm:block">
                  <p className="font-display text-sm font-semibold text-amber">{money(Number(job.invoice.total), job.invoice.currency)}</p>
                  <p className="text-[10px] text-muted-foreground">{t(`invst.${job.invoice.status}`, job.invoice.status)}</p>
                </div>
              )}
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}
