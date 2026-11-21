"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Inbox, Loader2, Check, X, ChevronRight } from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Job } from "@/lib/api";
import { StatusBadge, UrgencyBadge } from "@/components/mek/shared/status-badge";
import { EmptyState, SectionHeader } from "@/components/mek/shared/primitives";
import { MekIcon, iconForMachineType, iconForCategory } from "@/components/mek/shared/icons";
import { fmtMoney, fmtDistance, fmtDuration, fmtRelative, haversine, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function TechnicianRequests({ user }: { user: DemoUser }) {
  const { go } = useApp();
  const { t, isFa } = useT();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = () => {
    if (!user.technician) return;
    api.listJobs({ technicianId: user.technician.id }).then(setJobs).catch(() => setJobs([]));
  };
  useEffect(load, [user]);

  const accept = async (jobId: string) => {
    setActing(jobId);
    try {
      await api.updateJobStatus(jobId, "ACCEPTED");
      toast.success(t("tech.requests.accepted"));
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(null);
    }
  };

  const reject = async (jobId: string) => {
    setActing(jobId);
    try {
      // Use REJECTED status (distinct from CANCELLED) so the customer gets a
      // special "alert" notification and the request re-enters the matching pool.
      await api.updateJobStatus(jobId, "REJECTED");
      toast.success(t("tech.requests.declined"));
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(null);
    }
  };

  const incoming = (jobs ?? []).filter((j) => j.status === "REQUESTED");
  const active = (jobs ?? []).filter((j) => ["ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL"].includes(j.status));
  const recent = (jobs ?? []).filter((j) => ["COMPLETED", "CANCELLED", "REJECTED"].includes(j.status));

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("tech.requests.title")} subtitle={t("tech.requests.subtitle")} />

      <div>
        <h3 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold">
          <Inbox className="size-4 text-amber" /> {t("tech.requests.new")}
          {incoming.length > 0 && <span className="rounded-full bg-amber/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber">{isFa ? toPersianDigits(incoming.length) : incoming.length}</span>}
        </h3>
        {jobs === null ? (
          <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-32 rounded-xl bg-muted/60 mk-shimmer" />)}</div>
        ) : incoming.length === 0 ? (
          <EmptyState icon={Inbox} title={t("tech.requests.noNew")} description={t("tech.requests.noNewDesc")} />
        ) : (
          <div className="space-y-2">
            <AnimatePresence>
              {incoming.map((job) => (
                <RequestCard key={job.id} job={job} userLat={user.technician?.lat ?? null} userLng={user.technician?.lng ?? null} acting={acting === job.id} onAccept={() => accept(job.id)} onReject={() => reject(job.id)} onOpen={() => go("job-detail", { jobId: job.id })} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-display text-sm font-semibold">{t("tech.requests.active")}</h3>
        {active.length === 0 ? (
          <EmptyState icon={ChevronRight} title={t("tech.requests.noActive")} description={t("tech.requests.noActiveDesc")} />
        ) : (
          <div className="space-y-2">
            {active.map((job) => <ActiveRow key={job.id} job={job} onClick={() => go("job-detail", { jobId: job.id })} />)}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-display text-sm font-semibold">{t("tech.requests.recent")}</h3>
        {recent.length === 0 ? (
          <EmptyState icon={Check} title={t("tech.requests.noCompleted")} />
        ) : (
          <div className="space-y-2">
            {recent.slice(0, 6).map((job) => <ActiveRow key={job.id} job={job} onClick={() => go("job-detail", { jobId: job.id })} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestCard({ job, userLat, userLng, acting, onAccept, onReject, onOpen }: { job: Job; userLat: number | null; userLng: number | null; acting: boolean; onAccept: () => void; onReject: () => void; onOpen: () => void }) {
  const { t, isFa, money, type: typeLabel } = useT();
  const dist = userLat != null && userLng != null && job.request.lat
    ? haversine({ lat: userLat, lng: userLng }, { lat: job.request.lat, lng: job.request.lng })
    : null;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="overflow-hidden rounded-xl border border-amber/30 bg-amber/[0.04] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code}</span>
            <UrgencyBadge urgency={job.request.urgency} />
            <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{typeLabel(job.request.vehicle.type)}</span>
          </div>
          <p className="mt-1 font-display text-sm font-semibold">{job.request.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{job.request.description}</p>
        </button>
        <div className="shrink-0 text-right">
          <p className="font-display text-lg font-bold text-amber">{money(Number(job.technician.hourlyRate) * 1.5)}</p>
          <p className="text-[10px] text-muted-foreground">{t("tech.requests.estPayout")}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>{job.request.customer.user.name}</span>
        {dist != null && <span>{fmtDistance(dist, isFa ? "fa" : "en")} {t("tech.requests.away")}</span>}
        <span>{t("tech.requests.eta")} {fmtDuration(job.etaMins, isFa ? "fa" : "en")}</span>
        <span>{fmtRelative(job.createdAt, isFa ? "fa" : "en")}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={onAccept} disabled={acting} className="flex-1 bg-amber text-black hover:bg-amber/90">
          {acting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Check className="mr-1.5 size-4" />} {t("tech.requests.accept")}
        </Button>
        <Button onClick={onReject} disabled={acting} variant="outline" className="text-destructive hover:bg-destructive/10">
          <X className="mr-1.5 size-4" /> {t("tech.requests.decline")}
        </Button>
        <Button onClick={onOpen} variant="outline">{t("tech.requests.details")}</Button>
      </div>
    </motion.div>
  );
}

function ActiveRow({ job, onClick }: { job: Job; onClick: () => void }) {
  const { t, isFa, money, type: typeLabel } = useT();
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left mk-card-hover hover:border-amber/40">
      <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <MekIcon name={iconForMachineType(job.request.vehicle.type)} className="size-4 text-amber" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code}</span>
          <StatusBadge status={job.status} />
        </div>
        <p className="mt-0.5 truncate text-sm font-medium">{job.request.title}</p>
        <p className="text-[11px] text-muted-foreground">{job.request.customer.user.name} · {fmtRelative(job.updatedAt, isFa ? "fa" : "en")}</p>
      </div>
      {job.invoice && <span className="font-mono text-xs text-amber">{money(Number(job.invoice.total))}</span>}
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
