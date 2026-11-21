"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Phone, MessageSquare, ShieldAlert, X, MapPin, Navigation, Clock, Star, Loader2, CheckCircle2, BadgeCheck, ChevronRight, RefreshCw, Lock, CreditCard,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Job } from "@/lib/api";
import { MapView, routeInfo, type MapPoint } from "@/components/mek/shared/map-view";
import { JobStatusTimeline } from "@/components/mek/shared/job-status-timeline";
import { StatusBadge, UrgencyBadge } from "@/components/mek/shared/status-badge";
import { Button } from "@/components/ui/button";
import { fmtDistance, fmtDuration, fmtRelative, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { StarRating } from "@/components/mek/shared/primitives";
import { Textarea } from "@/components/ui/textarea";
import { PaymentGatewayDialog } from "@/components/mek/shared/payment-gateway";

export function CustomerTracking({ customer }: { customer: DemoUser }) {
  const { go, params, back } = useApp();
  const { t, isFa, type: typeLabel, money } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [prepayOpen, setPrepayOpen] = useState(false);
  const [prepayBusy, setPrepayBusy] = useState(false);

  const load = useCallback(async () => {
    if (!params.jobId) return;
    try {
      const j = await api.getJob(params.jobId);
      setJob(j);
    } catch {
      toast.error(t("track.jobNotFound"));
      go("home");
    } finally {
      setLoading(false);
    }
  }, [params.jobId]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 6000); // poll for updates
    return () => clearInterval(poll);
  }, [load]);

  const cancel = async () => {
    if (!job) return;
    try {
      const updated = await api.updateJobStatus(job.id, "CANCELLED");
      setJob(updated);
      setCancelOpen(false);
      toast.success(t("track.jobCancelledToast"));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  if (loading) {
    return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  }
  if (!job) return null;

  const techLoc = job.tracking.length ? job.tracking[job.tracking.length - 1] : null;
  const custLoc = { lat: job.request.lat, lng: job.request.lng };
  const route = (job.tracking.length
    ? job.tracking.map((p) => ({ lat: p.lat, lng: p.lng }))
    : techLoc ? [{ lat: techLoc.lat, lng: techLoc.lng }, custLoc] : []) as { lat: number; lng: number }[];
  const points: MapPoint[] = [
    { id: "cust", lat: custLoc.lat, lng: custLoc.lng, kind: "customer", label: job.request.vehicle.location ?? t("track.yourLocation") },
    ...(techLoc ? [{ id: "tech", lat: techLoc.lat, lng: techLoc.lng, kind: "technician" as const, label: job.technician.user.name }] : []),
  ];
  const info = techLoc ? routeInfo({ lat: techLoc.lat, lng: techLoc.lng }, custLoc, isFa ? "fa" : "en") : null;
  const isComplete = job.status === "COMPLETED";
  const isCancelled = job.status === "CANCELLED";

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      {/* Top bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => go("home")}><X className="size-4" /></Button>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code}</span>
              <UrgencyBadge urgency={job.request.urgency} />
            </div>
            <h1 className="font-display text-base font-semibold">{job.request.title}</h1>
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Map + status */}
        <div className="space-y-4">
          <div className="relative overflow-hidden rounded-xl border border-border">
            <MapView points={points} route={route} height={340} center={custLoc} />
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-background/90 p-2.5 backdrop-blur">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <div className="grid size-9 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                    {job.technician.user.avatar ? <img src={job.technician.user.avatar} alt="" className="size-full object-cover" /> : <span className="text-xs">{job.technician.user.name[0]}</span>}
                  </div>
                  <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-glow" />
                </div>
                <div>
                  <p className="text-xs font-medium">{job.technician.user.name}</p>
                  <p className="text-[10px] text-muted-foreground">{info ? info.label : t("track.calculatingEta")}</p>
                </div>
              </div>
              {job.status === "EN_ROUTE" && (
                <div className="text-right">
                  <p className="font-display text-lg font-bold text-amber">{isFa ? toPersianDigits(job.etaMins) : job.etaMins}<span className="text-[10px] text-muted-foreground"> {t("track.min")}</span></p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{t("track.estArrival")}</p>
                </div>
              )}
            </div>
          </div>

          {/* Status timeline */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold">{t("track.jobProgress")}</h3>
              <Button variant="ghost" size="sm" className="gap-1 text-[11px]" onClick={load}><RefreshCw className="size-3" /> {t("track.refresh")}</Button>
            </div>
            <div className="mt-4">
              <JobStatusTimeline status={job.status} />
            </div>
          </div>

          {/* Machine info */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("track.machine")}</h3>
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-border bg-background p-3">
              <div className="grid size-10 place-items-center rounded-lg border border-border bg-muted">
                <span className="font-mono text-[10px] uppercase">{typeLabel(job.request.vehicle.type)}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{job.request.vehicle.make} {job.request.vehicle.model}</p>
                <p className="text-[11px] text-muted-foreground">{isFa ? toPersianDigits(job.request.vehicle.year) : job.request.vehicle.year}{job.request.vehicle.plate ? ` · ${job.request.vehicle.plate}` : ""}</p>
              </div>
              <MapPin className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{job.request.description}</p>
          </div>
        </div>

        {/* Actions + technician */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("track.technician")}</h3>
            <div className="mt-3 flex items-center gap-3">
              <div className="grid size-12 place-items-center overflow-hidden rounded-xl border border-border bg-muted">
                {job.technician.user.avatar ? <img src={job.technician.user.avatar} alt="" className="size-full object-cover" /> : <span className="font-semibold">{job.technician.user.name[0]}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{job.technician.user.name}</p>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <StarRating value={Number(job.technician.rating ?? 0)} size={11} />
                  <span>{isFa ? toPersianDigits((job.technician as any).rating != null ? Number(job.technician.rating).toFixed(1) : "—") : ((job.technician as any).rating != null ? Number(job.technician.rating).toFixed(1) : "—")}</span>
                  <span>· {job.technician.user.phone ?? "—"}</span>
                </div>
              </div>
              {job.technician && <BadgeCheck className="size-4 text-amber" />}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {job.prepayPaid ? (
                <>
                  <Button variant="outline" onClick={() => go("chat", { jobId: job.id })}><MessageSquare className="mr-1.5 size-4" /> {t("track.chat")}</Button>
                  <Button variant="outline" onClick={() => toast.success(t("track.connectingCall"))}><Phone className="mr-1.5 size-4" /> {t("track.call")}</Button>
                </>
              ) : (
                <Button
                  className="col-span-2 bg-amber text-black hover:bg-amber/90"
                  onClick={() => setPrepayOpen(true)}
                >
                  <Lock className="mr-2 size-4" /> {t("fees.unlockCommunication")}
                </Button>
              )}
            </div>

            {/* Prepay required banner */}
            {!job.prepayPaid && (
              <div className="mt-3 rounded-lg border border-amber/30 bg-amber/5 p-3 text-[11px] text-muted-foreground">
                <p className="flex items-center gap-1.5 font-medium text-amber">
                  <Lock className="size-3" /> {t("fees.prepayTitle")}
                </p>
                <p className="mt-1">{t("fees.prepayDesc")}</p>
              </div>
            )}
          </div>

          {/* Diagnosis / estimate ready */}
          {job.status === "WAITING_APPROVAL" && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-amber/40 bg-amber/5 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-amber" />
                <h3 className="font-display text-sm font-semibold">{t("track.estimateReady")}</h3>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t("track.estimateReadyDesc")}</p>
              <Button onClick={() => go("invoice", { jobId: job.id })} className="mt-3 w-full bg-amber text-black hover:bg-amber/90">
                {t("track.viewEstimate")} <ChevronRight className="ml-1 size-4" />
              </Button>
            </motion.div>
          )}

          {job.diagnosis && ["DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(job.status) && (
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="font-display text-sm font-semibold">{t("track.diagnosis")}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{job.diagnosis}</p>
            </div>
          )}

          {/* Complete → invoice/review */}
          {isComplete && (
            <div className="space-y-3">
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-emerald-glow/40 bg-emerald-glow/5 p-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-5 text-emerald-glow" />
                  <h3 className="font-display text-sm font-semibold">{t("track.jobComplete")}</h3>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("track.jobCompleteDesc")}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Button onClick={() => go("invoice", { jobId: job.id })} variant="outline">{t("track.viewInvoice")}</Button>
                  <Button onClick={() => go("completion", { jobId: job.id })} className="bg-amber text-black hover:bg-amber/90">{t("track.completeRate")}</Button>
                </div>
              </motion.div>
            </div>
          )}

          {/* Cancel / emergency */}
          {!isComplete && !isCancelled && (
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="font-display text-sm font-semibold">{t("track.needHelp")}</h3>
              <div className="mt-3 space-y-2">
                <Button variant="outline" className="w-full justify-start text-destructive hover:bg-destructive/10" onClick={() => setCancelOpen(true)}>
                  <X className="mr-2 size-4" /> {t("track.cancelRequest")}
                </Button>
                <Button variant="outline" className="w-full justify-start" onClick={() => toast.success(t("track.emergencyConnected"))}>
                  <ShieldAlert className="mr-2 size-4 text-rose-500" /> {t("track.emergencyContact")}
                </Button>
              </div>
            </div>
          )}

          {isCancelled && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {t("track.jobCancelled")} <button onClick={() => go("home")} className="underline">{t("track.backHome")}</button>
            </div>
          )}
        </div>
      </div>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("track.cancelTitle")}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t("track.cancelBody")}</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>{t("track.keepJob")}</Button>
            <Button variant="destructive" onClick={cancel}>{t("track.cancelJob")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-service payment gateway */}
      {job && (() => {
        const machineType = job.request.vehicle.type;
        const heavy = machineType !== "CAR";
        const inspectionFee = heavy ? (job.technician as any).inspectionFeeHeavy ?? 20 : (job.technician as any).inspectionFee ?? 7;
        const travelFee = (job.technician as any).travelFeeBase ?? 3;
        const total = inspectionFee + travelFee;
        return (
          <PaymentGatewayDialog
            open={prepayOpen}
            onOpenChange={(v) => { setPrepayOpen(v); if (!v) load(); }}
            amount={total}
            purpose="prepay"
            description={t("fees.prepayTitle")}
            onSuccess={async (_paymentId) => {
              setPrepayBusy(true);
              try {
                const res = await authFetch("/api/prepay", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ jobId: job.id, method: "card" }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);
                setJob(data.job);
                toast.success(t("fees.prepayPaid"));
                setPrepayOpen(false);
              } catch (e: any) {
                toast.error(e.message ?? t("pay.gateway.failed"));
              } finally {
                setPrepayBusy(false);
              }
            }}
          />
        );
      })()}
    </div>
  );
}
