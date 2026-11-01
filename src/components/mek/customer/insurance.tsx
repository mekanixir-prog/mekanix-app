"use client";
import { authFetch } from "@/lib/fetch-with-auth";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield, Plus, Loader2, Save, FileText, ChevronRight, ShieldCheck,
  ShieldAlert, AlertTriangle, Calendar, DollarSign, Hash, Car, ClipboardList,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useT } from "@/lib/use-t";
import { api, type Vehicle } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { toast } from "sonner";
import { fmtDate, toPersianDigits } from "@/lib/format";

type Policy = {
  id: string;
  code: string;
  userId: string;
  vehicleId: string | null;
  vehicle: Vehicle | null;
  provider: string;
  policyNumber: string;
  type: string;
  startDate: string;
  endDate: string;
  premiumAmount: number;
  coverageAmount: number;
  status: string;
  notes: string | null;
  createdAt: string;
  claims: Claim[];
};

type Claim = {
  id: string;
  code: string;
  policyId: string;
  jobId: string | null;
  description: string;
  amount: number;
  status: string;
  reviewerNotes: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

const PROVIDERS = ["iran-mehr", "pasargad", "asia", "melli", "razi", "other"];
const TYPES = ["third-party", "comprehensive", "zero"];

const STATUS_TONE: Record<string, string> = {
  active: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
  expired: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-border bg-muted text-muted-foreground",
  claimed: "border-amber/30 bg-amber/10 text-amber",
};

const CLAIM_STATUS_TONE: Record<string, string> = {
  submitted: "border-sky-500/30 bg-sky-500/10 text-sky-400",
  under_review: "border-amber/30 bg-amber/10 text-amber",
  approved: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
  rejected: "border-destructive/30 bg-destructive/10 text-destructive",
  paid: "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow",
};

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

export function CustomerInsurance({ customer }: { customer: DemoUser }) {
  const { t, isFa, money, lang } = useT();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [claimPolicy, setClaimPolicy] = useState<Policy | null>(null);

  const userId = customer.id;

  const load = async () => {
    const cid = customer.customer?.id;
    if (!cid) return;
    try {
      const [v, p] = await Promise.all([
        api.listVehicles(cid),
        fetch(`/api/insurance?userId=${userId}`).then((r) => r.json()),
      ]);
      setVehicles(v);
      setPolicies(Array.isArray(p) ? (p as Policy[]) : []);
    } catch {
      setPolicies([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const cid = customer.customer?.id;
      if (!cid) return;
      try {
        const [v, p] = await Promise.all([
          api.listVehicles(cid),
          fetch(`/api/insurance?userId=${userId}`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setVehicles(v);
        setPolicies(Array.isArray(p) ? (p as Policy[]) : []);
      } catch {
        if (cancelled) return;
        setPolicies([]);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [customer]);

  if (policies === null) {
    return (
      <div className="grid min-h-[40vh] place-items-center" dir={isFa ? "rtl" : "ltr"}>
        <Loader2 className="size-6 animate-spin text-amber" />
      </div>
    );
  }

  const num = (n: number) => (isFa ? toPersianDigits(n) : String(n));
  const activeCount = policies.filter((p) => p.status === "active").length;
  const expiringSoonCount = policies.filter((p) => {
    if (p.status !== "active") return false;
    const d = daysUntil(p.endDate);
    return d !== null && d >= 0 && d <= 30;
  }).length;
  const totalCoverage = policies.reduce((s, p) => s + (p.coverageAmount ?? 0), 0);

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader
        title={t("ins.title")}
        subtitle={t("ins.subtitle")}
        action={
          <Button onClick={() => setAddOpen(true)} className="bg-amber text-black hover:bg-amber/90">
            <Plus className="mr-1.5 size-4" /> {t("ins.addPolicy")}
          </Button>
        }
      />

      {/* Summary */}
      {policies.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("ins.status.active")}</p>
            <p className="mt-1 font-display text-xl font-semibold text-emerald-glow">{num(activeCount)}</p>
          </div>
          <div className="rounded-lg border border-amber/30 bg-amber/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isFa ? "در حال انقضا" : "Expiring soon"}</p>
            <p className="mt-1 font-display text-xl font-semibold text-amber">{num(expiringSoonCount)}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isFa ? "مجموع پوشش" : "Total coverage"}</p>
            <p className="mt-1 font-display text-sm font-semibold text-amber">{money(totalCoverage)}</p>
          </div>
        </div>
      )}

      {/* Policy list */}
      {policies.length === 0 ? (
        <EmptyState
          icon={Shield}
          title={t("ins.noPolicies")}
          description={t("ins.noPoliciesDesc")}
          action={
            <Button onClick={() => setAddOpen(true)} className="bg-amber text-black hover:bg-amber/90">
              <Plus className="mr-1.5 size-4" /> {t("ins.addPolicy")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {policies.map((p, i) => {
              const days = daysUntil(p.endDate);
              const isExpired = p.status === "expired" || (days !== null && days < 0);
              const isExpiringSoon = !isExpired && days !== null && days <= 30;
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ delay: Math.min(i * 0.04, 0.3) }}
                >
                  <Card className="overflow-hidden py-0 transition-colors hover:border-amber/40">
                    <CardContent className="p-4">
                      {/* Header row */}
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber/30 bg-amber/10 px-2 py-0.5 text-[11px] font-medium text-amber">
                              <Shield className="size-3" />
                              {t(`ins.providers.${p.provider}`, p.provider)}
                            </span>
                            <Badge variant="outline" className="border-border text-[10px]">
                              {t(`ins.type.${p.type}`, p.type)}
                            </Badge>
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {isFa ? toPersianDigits(p.code) : p.code}
                            </span>
                            {p.status && (
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[p.status] ?? STATUS_TONE.active}`}>
                                <span className="size-1.5 rounded-full bg-current mk-status-pulse" />
                                {t(`ins.status.${p.status}`, p.status)}
                              </span>
                            )}
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <Hash className="size-3.5 text-muted-foreground" />
                            <code className="font-mono text-sm font-semibold">{p.policyNumber}</code>
                          </div>
                          {p.vehicle && (
                            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <Car className="size-3" /> {p.vehicle.make} {p.vehicle.model} ({isFa ? toPersianDigits(p.vehicle.year) : p.vehicle.year})
                            </p>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setClaimPolicy(p)}
                          disabled={p.status === "expired" || p.status === "cancelled"}
                          className="gap-1"
                        >
                          <FileText className="mr-1 size-3.5" /> {t("ins.fileClaim")}
                        </Button>
                      </div>

                      {/* Meta grid */}
                      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 md:grid-cols-4">
                        <Meta
                          icon={Calendar}
                          label={t("ins.startDate")}
                          value={fmtDate(p.startDate, undefined, lang)}
                        />
                        <Meta
                          icon={Calendar}
                          label={t("ins.endDate")}
                          value={fmtDate(p.endDate, undefined, lang)}
                          tone={isExpired ? "rose" : isExpiringSoon ? "amber" : "neutral"}
                        />
                        <Meta icon={DollarSign} label={t("ins.premium")} value={money(p.premiumAmount)} tone="amber" />
                        <Meta icon={ShieldCheck} label={t("ins.coverage")} value={money(p.coverageAmount)} tone="emerald" />
                      </div>

                      {/* Expiry warning */}
                      {isExpired && p.status === "expired" && days !== null && (
                        <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
                          <ShieldAlert className="size-3.5" />
                          {t("ins.expired").replace("{days}", num(Math.abs(days)))}
                        </div>
                      )}
                      {!isExpired && isExpiringSoon && days !== null && (
                        <div className="mt-3 flex items-center gap-2 rounded-md border border-amber/30 bg-amber/5 p-2 text-[11px] text-amber">
                          <AlertTriangle className="size-3.5" />
                          {t("ins.expiresIn").replace("{days}", num(days))}
                        </div>
                      )}

                      {/* Notes */}
                      {p.notes && (
                        <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">{p.notes}</p>
                      )}

                      {/* Claims list */}
                      {p.claims.length > 0 && (
                        <div className="mt-3 border-t border-border pt-3">
                          <p className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            <ClipboardList className="size-3" /> {t("ins.claims")}
                          </p>
                          <div className="space-y-1.5">
                            {p.claims.map((c) => (
                              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/60 p-2 text-[11px]">
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {isFa ? toPersianDigits(c.code) : c.code}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-foreground">{c.description}</span>
                                <span className="font-mono text-amber">{money(c.amount)}</span>
                                <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${CLAIM_STATUS_TONE[c.status] ?? CLAIM_STATUS_TONE.submitted}`}>
                                  {t(`ins.claimStatus.${c.status}`, c.status)}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {fmtDate(c.createdAt, undefined, lang)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <AddPolicyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        vehicles={vehicles}
        userId={userId}
        onCreated={load}
      />

      <FileClaimDialog
        policy={claimPolicy}
        onOpenChange={(v) => !v && setClaimPolicy(null)}
        onSubmitted={load}
      />
    </div>
  );
}

function Meta({ icon: Icon, label, value, tone = "neutral" }: { icon: any; label: string; value: string; tone?: string }) {
  const toneMap: Record<string, string> = {
    neutral: "text-foreground",
    amber: "text-amber",
    emerald: "text-emerald-glow",
    rose: "text-destructive",
  };
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" /> {label}
      </p>
      <p className={`mt-0.5 truncate text-xs font-medium ${toneMap[tone] ?? toneMap.neutral}`}>{value}</p>
    </div>
  );
}

function AddPolicyDialog({
  open,
  onOpenChange,
  vehicles,
  userId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  vehicles: Vehicle[];
  userId: string;
  onCreated: () => void;
}) {
  const { t, isFa } = useT();
  const [vehicleId, setVehicleId] = useState("");
  const [provider, setProvider] = useState("iran-mehr");
  const [policyNumber, setPolicyNumber] = useState("");
  const [type, setType] = useState("third-party");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [premiumAmount, setPremiumAmount] = useState("");
  const [coverageAmount, setCoverageAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setVehicleId("");
    setProvider("iran-mehr");
    setPolicyNumber("");
    setType("third-party");
    setStartDate("");
    setEndDate("");
    setPremiumAmount("");
    setCoverageAmount("");
    setNotes("");
  };

  const submit = async () => {
    if (!provider || !policyNumber.trim() || !startDate || !endDate) {
      toast.error(isFa ? "لطفاً تمام فیلدهای ضروری را پر کنید" : "Please fill all required fields");
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch("/api/insurance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          vehicleId: vehicleId || null,
          provider,
          policyNumber: policyNumber.trim(),
          type,
          startDate,
          endDate,
          premiumAmount: parseFloat(premiumAmount) || 0,
          coverageAmount: parseFloat(coverageAmount) || 0,
          notes: notes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(isFa ? "بیمه‌نامه اضافه شد" : "Policy added");
      onCreated();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to add policy");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Shield className="size-5 text-amber" /> {t("ins.addPolicy")}
          </DialogTitle>
          <DialogDescription>{t("ins.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Vehicle (optional) */}
          <div>
            <Label className="text-xs">{t("fleet.vehicle")} ({isFa ? "اختیاری" : "optional"})</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={isFa ? "بدون خودرو" : "No vehicle"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">{isFa ? "بدون خودرو" : "No vehicle"}</SelectItem>
                {vehicles.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.make} {v.model} ({isFa ? toPersianDigits(v.year) : v.year})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Provider */}
          <div>
            <Label className="text-xs">{t("ins.provider")}</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>{t(`ins.providers.${p}`, p)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Policy number */}
          <div>
            <Label className="text-xs">{t("ins.policyNumber")}</Label>
            <Input
              value={policyNumber}
              onChange={(e) => setPolicyNumber(e.target.value)}
              className="mt-1 font-mono"
              placeholder={isFa ? "مثلاً: 12345678" : "e.g. 12345678"}
            />
          </div>

          {/* Type */}
          <div>
            <Label className="text-xs">{t("ins.type")}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPES.map((tp) => (
                  <SelectItem key={tp} value={tp}>{t(`ins.type.${tp}`, tp)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">{t("ins.startDate")}</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">{t("ins.endDate")}</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          {/* Amounts */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">{t("ins.premium")} (USD)</Label>
              <Input
                type="number"
                value={premiumAmount}
                onChange={(e) => setPremiumAmount(e.target.value)}
                className="mt-1"
                placeholder="e.g. 50"
              />
            </div>
            <div>
              <Label className="text-xs">{t("ins.coverage")} (USD)</Label>
              <Input
                type="number"
                value={coverageAmount}
                onChange={(e) => setCoverageAmount(e.target.value)}
                className="mt-1"
                placeholder="e.g. 5000"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-xs">{isFa ? "یادداشت" : "Notes"}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1"
              placeholder={isFa ? "توضیحات اختیاری…" : "Optional notes…"}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{isFa ? "انصراف" : "Cancel"}</Button>
          <Button onClick={submit} disabled={saving} className="bg-amber text-black hover:bg-amber/90">
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Save className="mr-1.5 size-4" />}
            {saving ? (isFa ? "در حال ذخیره" : "Saving") : (isFa ? "ذخیره" : "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileClaimDialog({
  policy,
  onOpenChange,
  onSubmitted,
}: {
  policy: Policy | null;
  onOpenChange: (v: boolean) => void;
  onSubmitted: () => void;
}) {
  const { t, isFa, money, lang } = useT();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const claimIdempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (policy) {
      setDescription("");
      setAmount("");
      claimIdempotencyRef.current = null;
    }
  }, [policy]);

  const submit = async () => {
    if (!policy) return;
    if (!description.trim()) {
      toast.error(isFa ? "توضیحات الزامی است" : "Description is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        policyId: policy.id,
        description: description.trim(),
        amount: parseFloat(amount) || 0,
      };
      const signature = JSON.stringify(payload);
      if (!claimIdempotencyRef.current || claimIdempotencyRef.current.signature !== signature) {
        claimIdempotencyRef.current = {
          signature,
          key: globalThis.crypto.randomUUID(),
        };
      }
      const res = await authFetch("/api/insurance/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": claimIdempotencyRef.current.key,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(t("ins.claimSubmitted"));
      onSubmitted();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to submit claim");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!policy} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <FileText className="size-5 text-amber" /> {t("ins.fileClaim")}
          </DialogTitle>
          <DialogDescription>
            {policy && (
              <>
                {t(`ins.providers.${policy.provider}`, policy.provider)} · <span className="font-mono">{policy.policyNumber}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">{t("ins.claimDesc")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="mt-1"
              placeholder={isFa ? "خسارت رخ داده را شرح دهید…" : "Describe the incident / damage…"}
            />
          </div>
          <div>
            <Label className="text-xs">{t("ins.claimAmount")} (USD)</Label>
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1"
              placeholder="e.g. 250"
            />
            {amount && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {isFa ? "معادل:" : "Equivalent:"} <span className="font-medium text-amber">{money(parseFloat(amount) || 0)}</span>
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{isFa ? "انصراف" : "Cancel"}</Button>
          <Button onClick={submit} disabled={saving} className="bg-amber text-black hover:bg-amber/90">
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <FileText className="mr-1.5 size-4" />}
            {saving ? (isFa ? "در حال ارسال" : "Submitting") : (isFa ? "ثبت خسارت" : "Submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
