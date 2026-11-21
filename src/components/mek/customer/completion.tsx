"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, ShieldCheck, Star, Wrench, CheckCircle2, ArrowLeft } from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Job } from "@/lib/api";
import { fmtDate, parseMedia, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/mek/shared/primitives";
import { toast } from "sonner";

const TAG_KEYS = ["punctual", "knowledgeable", "clean", "communication", "fairPrice", "recommend"];

export function CustomerCompletion({ customer }: { customer: DemoUser }) {
  const { go, params, back } = useApp();
  const { t, isFa } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!params.jobId) return;
    api.getJob(params.jobId).then((j) => {
      setJob(j);
      setSubmitted(j.reviews.some((r) => r.fromUserId === customer.id));
    }).finally(() => setLoading(false));
  }, [params.jobId]);

  const submit = async () => {
    if (!job) return;
    setSubmitting(true);
    try {
      await api.createReview({
        jobId: job.id,
        technicianId: job.technicianId,
        rating,
        comment: comment.trim() || undefined,
      } as any);
      setSubmitted(true);
      toast.success(t("completion.thanksToast"));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!job) return null;

  const warranty = (job as any).warranty;
  const parts = job.parts;

  return (
    <div className="mx-auto max-w-2xl space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <button onClick={back} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t("common.back")}
      </button>

      {/* Completion banner */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-xl border border-emerald-glow/30 bg-gradient-to-br from-emerald-glow/10 to-transparent p-5 text-center">
        <div className="absolute inset-0 mk-grid-bg opacity-20" />
        <div className="relative">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
            className="mx-auto grid size-14 place-items-center rounded-full border-2 border-emerald-glow bg-emerald-glow/15"
          >
            <CheckCircle2 className="size-7 text-emerald-glow" />
          </motion.div>
          <h1 className="mt-3 font-display text-xl font-semibold">{t("completion.title")}</h1>
          <p className="text-sm text-muted-foreground">{isFa ? toPersianDigits(job.code) : job.code} · {job.request.vehicle.make} {job.request.vehicle.model}</p>
        </div>
      </motion.div>

      {/* Repair summary */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-display text-sm font-semibold">{t("completion.repairSummary")}</h3>
        <div className="mt-3 space-y-3 text-sm">
          {job.diagnosis && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("completion.diagnosis")}</p>
              <p className="mt-1">{job.diagnosis}</p>
            </div>
          )}
          {job.technicianNotes && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("completion.technicianNotes")}</p>
              <p className="mt-1 text-muted-foreground">{job.technicianNotes}</p>
            </div>
          )}
        </div>

        {/* Replaced parts */}
        {parts.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("completion.replacedParts")}</p>
            <div className="mt-2 space-y-1.5">
              {parts.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  <span className="font-medium">{p.name} <span className="text-[11px] text-muted-foreground">×{isFa ? toPersianDigits(p.quantity) : p.quantity}</span></span>
                  {p.sku && <span className="font-mono text-[10px] text-muted-foreground">{p.sku}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Warranty */}
      <div className="rounded-xl border border-amber/30 bg-amber/5 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-amber" />
          <h3 className="font-display text-sm font-semibold">{t("completion.warrantyActive")}</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("completion.warrantyDesc")}
        </p>
      </div>

      {/* Review */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Star className="size-4 text-amber" />
          <h3 className="font-display text-sm font-semibold">{t("completion.rateTitle")}</h3>
        </div>
        {submitted ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 p-3 text-sm text-emerald-glow">
            <CheckCircle2 className="size-4" /> {t("completion.thanks")}
          </div>
        ) : (
          <>
            <p className="mt-1 text-xs text-muted-foreground">{t("completion.rateQuestion").replace("{name}", job.technician.user.name)}</p>
            <div className="mt-3 flex justify-center gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <button key={i} onClick={() => setRating(i)} className="p-1">
                  <Star className={`size-8 transition-colors ${i <= rating ? "fill-amber text-amber" : "text-muted-foreground/40"}`} />
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {TAG_KEYS.map((key) => {
                const label = t(`completion.tag.${key}`);
                return (
                  <button
                    key={key}
                    onClick={() => setTags((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${tags.includes(key) ? "border-amber bg-amber/15 text-amber" : "border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("completion.commentPlaceholder")} rows={3} className="mt-3" maxLength={400} />
            <Button onClick={submit} disabled={submitting} className="mt-3 w-full bg-amber text-black hover:bg-amber/90">
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Star className="mr-2 size-4" />}
              {t("completion.submit")}
            </Button>
          </>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => go("service-history")}>{t("completion.viewHistory")}</Button>
        <Button className="flex-1 bg-amber text-black hover:bg-amber/90" onClick={() => go("home")}>
          <Wrench className="mr-2 size-4" /> {t("completion.done")}
        </Button>
      </div>
    </div>
  );
}
