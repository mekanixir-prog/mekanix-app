"use client";
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Loader2, MapPin, Phone, MessageSquare, Navigation, Wrench, Check, Plus, Trash2,
  FileText, Send, ChevronRight, CircleCheck, CircleDashed, Package, ClipboardList,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Job, type Invoice } from "@/lib/api";
import { MapView, routeInfo, type MapPoint } from "@/components/mek/shared/map-view";
import { JobStatusTimeline } from "@/components/mek/shared/job-status-timeline";
import { StatusBadge, UrgencyBadge } from "@/components/mek/shared/status-badge";
import { MekIcon, iconForMachineType, iconForCategory } from "@/components/mek/shared/icons";
import { fmtDistance, fmtDuration, fmtRelative, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { JOB_STATUS_FLOW } from "@/lib/constants";

const NEXT_STATUS: Record<string, string> = {
  REQUESTED: "ACCEPTED",
  ACCEPTED: "EN_ROUTE",
  EN_ROUTE: "ARRIVED",
  ARRIVED: "DIAGNOSING",
  DIAGNOSING: "REPAIRING",
  REPAIRING: "WAITING_APPROVAL",
  WAITING_APPROVAL: "WAITING_APPROVAL",
  COMPLETED: "COMPLETED",
};

const NEXT_ACTION_KEYS: Record<string, { key: string; icon: any }> = {
  REQUESTED: { key: "tech.jobDetail.action.acceptJob", icon: Check },
  ACCEPTED: { key: "tech.jobDetail.action.startTravel", icon: Navigation },
  EN_ROUTE: { key: "tech.jobDetail.action.markArrived", icon: MapPin },
  ARRIVED: { key: "tech.jobDetail.action.beginDiagnosis", icon: ClipboardList },
  DIAGNOSING: { key: "tech.jobDetail.action.startRepair", icon: Wrench },
  REPAIRING: { key: "tech.jobDetail.action.sendEstimate", icon: FileText },
  WAITING_APPROVAL: { key: "tech.jobDetail.action.awaitingApproval", icon: CircleDashed },
  COMPLETED: { key: "tech.jobDetail.action.completed", icon: CircleCheck },
};

export function TechnicianJobDetail({ user }: { user: DemoUser }) {
  const { go, params, back } = useApp();
  const { t, isFa, money, cat, type: typeLabel } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);
  const [diagnosis, setDiagnosis] = useState("");
  const [faultCode, setFaultCode] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [savingDiag, setSavingDiag] = useState(false);
  const [partName, setPartName] = useState("");
  const [partQty, setPartQty] = useState("1");
  const [partPrice, setPartPrice] = useState("");
  const [addingPart, setAddingPart] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);

  const load = useCallback(async () => {
    if (!params.jobId) return;
    try {
      const j = await api.getJob(params.jobId);
      setJob(j);
      if (!diagnosis && j.diagnosis) setDiagnosis(j.diagnosis);
    } catch {
      toast.error(t("tech.jobDetail.notFound"));
      go("requests");
    } finally {
      setLoading(false);
    }
  }, [params.jobId]);

  useEffect(() => {
    load();
    const poll = setInterval(load, 8000);
    return () => clearInterval(poll);
  }, [load]);

  const advance = async () => {
    if (!job) return;
    const next = NEXT_STATUS[job.status];
    if (next === job.status) return;
    setAdvancing(true);
    try {
      const updated = await api.updateJobStatus(job.id, next);
      setJob(updated);
      toast.success(t("tech.jobDetail.statusSet").replace("{label}", t(`status.${next}`)));
      if (next === "WAITING_APPROVAL") setShowInvoice(true);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setAdvancing(false);
    }
  };

  const saveDiagnosis = async () => {
    if (!job || !diagnosis.trim()) { toast.error(t("tech.jobDetail.errorDiagnosis")); return; }
    setSavingDiag(true);
    try {
      const updated = await api.setJobDiagnosis(job.id, diagnosis.trim(), severity, faultCode || undefined);
      setJob(updated);
      toast.success(t("tech.jobDetail.diagnosisSaved"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingDiag(false);
    }
  };

  const addPart = async () => {
    if (!job || !partName.trim()) { toast.error(t("tech.jobDetail.errorPartName")); return; }
    const quantity = Number(partQty);
    const unitPrice = Number(partPrice);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      toast.error(isFa ? "تعداد قطعه باید عدد صحیح مثبت باشد" : "Part quantity must be a positive integer");
      return;
    }
    if (partPrice.trim() === "" || !Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      toast.error(isFa ? "قیمت واحد را به‌صورت عدد صحیح نامنفی به ریال وارد کنید" : "Enter a non-negative integer unit price in IRR");
      return;
    }
    setAddingPart(true);
    try {
      await api.addPart(job.id, {
        name: partName.trim(),
        quantity,
        unitPrice,
      });
      const fresh = await api.getJob(job.id);
      setJob(fresh);
      setPartName(""); setPartQty("1"); setPartPrice("");
      toast.success(t("tech.jobDetail.partAdded"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setAddingPart(false);
    }
  };

  const removePart = async (partId: string) => {
    if (!job) return;
    await api.removePart(job.id, partId);
    const fresh = await api.getJob(job.id);
    setJob(fresh);
    toast.success(t("tech.jobDetail.partRemoved"));
  };

  // Issue invoice to BOTH parties — calls /api/invoices POST which sends
  // notifications to both customer and mechanic + posts a system message
  // in the job chat.
  const issueInvoice = async () => {
    if (!job) return;
    try {
      const inv = await api.createInvoice(job.id, { auto: true });
      const fresh = await api.getJob(job.id);
      setJob(fresh);
      toast.success(t("invoice.issued").replace("{code}", isFa ? toPersianDigits(inv.code) : inv.code));
    } catch (e: any) {
      toast.error(e.message ?? "Failed to issue invoice");
    }
  };

  // Send existing invoice to both parties (re-notify)
  const resendInvoice = async () => {
    if (!job?.invoice) return;
    try {
      // Re-issue creates a fresh notification to both parties (the API
      // upserts the invoice by jobId, so it won't create duplicates).
      const inv = await api.createInvoice(job.id, { auto: false, code: job.invoice.code, status: "SENT" });
      const fresh = await api.getJob(job.id);
      setJob(fresh);
      toast.success(t("invoice.issued").replace("{code}", isFa ? toPersianDigits(inv.code) : inv.code));
    } catch (e: any) {
      toast.error(e.message ?? "Failed to resend invoice");
    }
  };

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!job) return null;

  const next = NEXT_STATUS[job.status];
  const nextMeta = NEXT_ACTION_KEYS[job.status];
  const canAdvance = job.status !== "COMPLETED" && job.status !== "CANCELLED" && next !== job.status;
  const techLoc = { lat: user.technician?.lat ?? 37.77, lng: user.technician?.lng ?? -122.42 };
  const custLoc = { lat: job.request.lat, lng: job.request.lng };
  const info = routeInfo(techLoc, custLoc, isFa ? "fa" : "en");
  const points: MapPoint[] = [
    { id: "tech", lat: techLoc.lat, lng: techLoc.lng, kind: "technician", label: t("tech.dashboard.youOnline").split(" ")[0] },
    { id: "cust", lat: custLoc.lat, lng: custLoc.lng, kind: "customer", label: job.request.vehicle.location ?? t("tech.jobDetail.customer") },
  ];
  const isComplete = job.status === "COMPLETED";
  const invoiceFinanciallyVerified = job.invoice?.financialUnitStatus === "VERIFIED_IRR";
  const technicianFeesVerified = job.technician?.financialUnitStatus === "VERIFIED_IRR";
  const partsFinanciallyVerified = job.parts.every((part) => part.financialUnitStatus === "VERIFIED_IRR");
  const laborAmount = invoiceFinanciallyVerified
    ? (job.invoice?.laborTotal == null ? null : Number(job.invoice.laborTotal))
    : technicianFeesVerified ? (job.invoice?.laborHours ?? 1.5) * Number(job.technician.hourlyRate) : null;
  const partsAmount = invoiceFinanciallyVerified
    ? (job.invoice?.partsTotal == null ? null : Number(job.invoice.partsTotal))
    : partsFinanciallyVerified ? job.parts.reduce((sum, part) => sum + Number(part.unitPrice) * part.quantity, 0) : null;
  const travelAmount = invoiceFinanciallyVerified
    ? (job.invoice?.travelFee == null ? null : Number(job.invoice.travelFee))
    : technicianFeesVerified ? Number(job.technician.travelFeeBase) : null;
  const totalAmount = invoiceFinanciallyVerified && job.invoice?.total != null ? Number(job.invoice.total) : null;

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="size-8" onClick={back}><ArrowLeft className="size-4" /></Button>
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

      {/* Action bar */}
      {!isComplete && job.status !== "CANCELLED" && (
        <div className="sticky top-14 z-30 rounded-xl border border-amber/30 bg-background/95 p-3 backdrop-blur mk-amber-glow">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tech.jobDetail.nextAction")}</p>
              <p className="font-display text-sm font-semibold">{t(nextMeta.key)}</p>
            </div>
            <Button onClick={advance} disabled={!canAdvance || advancing} className="bg-amber text-black hover:bg-amber/90">
              {advancing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <nextMeta.icon className="mr-2 size-4" />}
              {canAdvance ? t("tech.jobDetail.continue") : t("tech.jobDetail.waiting")}
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {/* Map */}
          <div className="overflow-hidden rounded-xl border border-border">
            <MapView points={points} route={[techLoc, custLoc]} height={240} center={custLoc} />
          </div>

          {/* Customer + machine */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tech.jobDetail.customer")}</p>
              <div className="mt-2 flex items-center gap-3">
                <div className="grid size-10 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                  {job.request.customer.user.avatar ? <img src={job.request.customer.user.avatar} alt="" className="size-full object-cover" /> : <span className="text-xs">{job.request.customer.user.name[0]}</span>}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.request.customer.user.name}</p>
                  <p className="text-[11px] text-muted-foreground">{job.request.customer.user.phone ?? "—"}</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => toast.success(t("toast.calling"))}><Phone className="mr-1 size-3.5" /> {t("track.call")}</Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={() => go("chat", { jobId: job.id })}><MessageSquare className="mr-1 size-3.5" /> {t("track.chat")}</Button>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tech.jobDetail.machine")}</p>
              <div className="mt-2 flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-lg border border-border bg-background">
                  <MekIcon name={iconForMachineType(job.request.vehicle.type)} className="size-5 text-amber" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.request.vehicle.make} {job.request.vehicle.model}</p>
                  <p className="text-[11px] text-muted-foreground">{typeLabel(job.request.vehicle.type)} · {isFa ? toPersianDigits(job.request.vehicle.year) : job.request.vehicle.year}{job.request.vehicle.plate ? ` · ${job.request.vehicle.plate}` : ""}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px]">
                <MapPin className="size-3.5 text-amber" />
                <span className="truncate">{job.request.address}</span>
                <span className="ml-auto text-muted-foreground">{info.label}</span>
              </div>
            </div>
          </div>

          {/* Problem description */}
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("tech.jobDetail.reportedProblem")}</p>
            <p className="mt-1 text-sm">{job.request.description}</p>
            <div className="mt-2 flex items-center gap-2">
              <Badge variant="outline" className="gap-1">
                <MekIcon name={iconForCategory(job.request.category)} className="size-3 text-amber" />
                {cat(job.request.category)}
              </Badge>
            </div>
          </div>

          {/* Diagnosis */}
          {["DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(job.status) && (
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <ClipboardList className="size-4 text-amber" />
                <h3 className="font-display text-sm font-semibold">{t("tech.jobDetail.diagnosis")}</h3>
              </div>
              <Textarea value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} placeholder={t("tech.jobDetail.diagnosisPlaceholder")} rows={3} className="mt-3" />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px]">{t("tech.jobDetail.faultCode")}</Label>
                  <Input value={faultCode} onChange={(e) => setFaultCode(e.target.value)} placeholder={t("tech.jobDetail.faultCodePlaceholder")} className="mt-1 h-8 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px]">{t("tech.jobDetail.severity")}</Label>
                  <div className="mt-1 flex gap-1">
                    {["low", "medium", "high"].map((s) => (
                      <button key={s} onClick={() => setSeverity(s)} className={`flex-1 rounded border px-2 py-1 text-[10px] ${severity === s ? "border-amber bg-amber/15 text-amber" : "border-border text-muted-foreground"}`}>{t(`tech.jobDetail.severity.${s}`)}</button>
                    ))}
                  </div>
                </div>
              </div>
              <Button onClick={saveDiagnosis} disabled={savingDiag} size="sm" className="mt-2 bg-amber text-black hover:bg-amber/90">
                {savingDiag ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Check className="mr-1.5 size-3.5" />} {t("tech.jobDetail.saveDiagnosis")}
              </Button>
            </div>
          )}

          {/* Parts */}
          {["REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(job.status) && (
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <Package className="size-4 text-amber" />
                <h3 className="font-display text-sm font-semibold">{t("tech.jobDetail.parts")}</h3>
              </div>
              {job.parts.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {job.parts.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground">×{isFa ? toPersianDigits(p.quantity) : p.quantity}</span>
                      <span className="tabular-nums text-amber">{money(p.unitPrice == null ? null : Number(p.unitPrice))}</span>
                      <button onClick={() => removePart(p.id)} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 grid grid-cols-[1fr_60px_80px_auto] gap-2">
                <Input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder={t("tech.jobDetail.partName")} className="h-8 text-xs" />
                <Input value={partQty} onChange={(e) => setPartQty(e.target.value)} type="number" min={1} step={1} placeholder={t("tech.jobDetail.qty")} className="h-8 text-xs" />
                <Input value={partPrice} onChange={(e) => setPartPrice(e.target.value)} type="number" min={0} step={1} placeholder={t("tech.jobDetail.price")} className="h-8 text-xs" />
                <Button onClick={addPart} disabled={addingPart} size="sm" className="bg-amber text-black hover:bg-amber/90">
                  {addingPart ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Timeline */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("tech.jobDetail.progress")}</h3>
            <div className="mt-4"><JobStatusTimeline status={job.status} /></div>
          </div>

          {/* Estimate preview */}
          {["REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(job.status) && (
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-sm font-semibold">{t("tech.jobDetail.estimatePreview")}</h3>
                {job.invoice && <StatusBadge status={job.invoice.status === "PAID" ? "COMPLETED" : "WAITING_APPROVAL"} />}
              </div>
              <div className="mt-3 space-y-1.5 text-sm">
                <EstLine label={t("tech.jobDetail.labor").replace("{hours}", isFa ? toPersianDigits(String(job.invoice?.laborHours ?? 1.5)) : String(job.invoice?.laborHours ?? 1.5))} amount={laborAmount} moneyFn={money} />
                <EstLine label={t("tech.jobDetail.partsShort")} amount={partsAmount} moneyFn={money} />
                <EstLine label={t("tech.jobDetail.travelFee")} amount={travelAmount} moneyFn={money} />
                <div className="border-t border-border pt-1.5" />
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t("tech.jobDetail.estTotal")}</span>
                  <span className="font-display text-lg font-bold text-amber">{money(totalAmount)}</span>
                </div>
                {totalAmount === null && (
                  <p className="text-[11px] text-muted-foreground">
                    {isFa ? "جمع نهایی پس از تأیید منشأ مبالغ و تعرفه‌ها نمایش داده می‌شود." : "The final total appears after the amounts and rate card are verified."}
                  </p>
                )}
              </div>
              {job.status === "REPAIRING" && (
                <Button onClick={advance} className="mt-3 w-full bg-amber text-black hover:bg-amber/90">
                  <FileText className="mr-2 size-4" /> {t("tech.jobDetail.sendEstimate")}
                </Button>
              )}
              {job.invoice && (
                <div className="mt-2 rounded-lg border border-amber/30 bg-amber/5 p-2.5 text-[11px] text-muted-foreground">
                  {job.invoice.status === "PAID" ? t("tech.jobDetail.invoicePaid") : job.customerApproved ? t("tech.jobDetail.customerApproved") : t("tech.jobDetail.waitingApproval")}
                </div>
              )}
              {job.invoice && (
                <Button onClick={resendInvoice} variant="outline" size="sm" className="mt-2 w-full">
                  <FileText className="mr-1.5 size-3.5" /> {t("tech.jobDetail.issueInvoice").replace("{code}", isFa ? toPersianDigits(job.invoice.code) : job.invoice.code)}
                </Button>
              )}
              {!job.invoice && (
                <Button onClick={issueInvoice} variant="outline" size="sm" className="mt-2 w-full">
                  <FileText className="mr-1.5 size-3.5" /> {t("tech.jobDetail.sendEstimate")}
                </Button>
              )}
            </div>
          )}

          {/* System messages */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("tech.jobDetail.activity")}</h3>
            <div className="mt-2 space-y-1.5">
              {job.messages.filter((m) => m.kind === "system").slice(-4).map((m) => (
                <div key={m.id} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] text-muted-foreground">
                  <span className="font-mono text-[9px]">{fmtRelative(m.createdAt, isFa ? "fa" : "en")}</span> · {m.body}
                </div>
              ))}
              {job.messages.filter((m) => m.kind === "system").length === 0 && <p className="text-[11px] text-muted-foreground">{t("tech.jobDetail.noActivity")}</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => go("chat", { jobId: job.id })}><MessageSquare className="mr-2 size-4" /> {t("tech.jobDetail.openChat")}</Button>
        {isComplete && <Button className="flex-1 bg-amber text-black hover:bg-amber/90" onClick={() => go("earnings")}>{t("tech.jobDetail.viewEarnings")} <ChevronRight className="ml-1 size-4" /></Button>}
      </div>
    </div>
  );
}

function EstLine({ label, amount, moneyFn }: { label: string; amount: number | null; moneyFn: (n: unknown) => string }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{moneyFn(amount)}</span>
    </div>
  );
}
