"use client";
import { AlertTriangle, CheckCircle2, XCircle, Clock, MessageSquare } from "lucide-react";
import { SectionHeader } from "@/components/mek/shared/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtRelative, toPersianDigits } from "@/lib/format";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useT } from "@/lib/use-t";

// Mock disputes (no persistence needed for demo)
const DISPUTES = [
  { id: "DSP-2207", job: "JOB-4012", customer: "Daniel Reyes", technician: "Marcus Cole", reasonKey: "recurred", amount: 482, status: "open", priority: "high", ts: Date.now() - 2 * 3600_000 },
  { id: "DSP-2198", job: "JOB-3905", customer: "Amara Okafor", technician: "Hassan Al-Farsi", reasonKey: "estimateMismatch", amount: 156, status: "investigating", priority: "medium", ts: Date.now() - 6 * 3600_000 },
  { id: "DSP-2185", job: "JOB-3890", customer: "Lukas Brandt", technician: "Tobias Klein", reasonKey: "lateArrival", amount: 0, status: "open", priority: "low", ts: Date.now() - dayMs(1) },
  { id: "DSP-2171", job: "JOB-3871", customer: "Sara Lindqvist", technician: "Yuki Tanaka", reasonKey: "wrongPart", amount: 220, status: "resolved", priority: "high", ts: Date.now() - dayMs(3) },
  { id: "DSP-2160", job: "JOB-3850", customer: "Mateo Herrera", technician: "Omar Saleh", reasonKey: "unusedParts", amount: 95, status: "resolved", priority: "low", ts: Date.now() - dayMs(5) },
];

function dayMs(d: number) { return d * 86400000; }

export function AdminDisputes() {
  const { t, isFa, money, lang } = useT();
  const resolve = (id: string) => toast.success(t("admin.disputes.resolvedToast").replace("{id}", id));
  const escalate = (id: string) => toast.info(t("admin.disputes.escalated").replace("{id}", id));

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.disputes.title")} subtitle={t("admin.disputes.subtitle")} />
      <div className="space-y-2">
        {DISPUTES.map((d, i) => (
          <motion.div
            key={d.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`grid size-10 shrink-0 place-items-center rounded-lg border ${d.priority === "high" ? "border-destructive/30 bg-destructive/10 text-destructive" : d.priority === "medium" ? "border-amber/30 bg-amber/10 text-amber" : "border-border bg-muted text-muted-foreground"}`}>
                  <AlertTriangle className="size-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">{isFa ? toPersianDigits(d.id) : d.id}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">· {isFa ? toPersianDigits(d.job) : d.job}</span>
                    <Badge variant={d.status === "resolved" ? "default" : "secondary"} className={d.status === "resolved" ? "bg-emerald-glow/15 text-emerald-glow" : d.status === "investigating" ? "bg-amber/15 text-amber" : ""}>{t(`dspst.${d.status}`, d.status)}</Badge>
                    <Badge variant="outline">{t(`admin.disputes.priority.${d.priority}`, d.priority)}</Badge>
                  </div>
                  <p className="mt-1 text-sm font-medium">{t(`admin.disputes.reason.${d.reasonKey}`)}</p>
                  <p className="text-[11px] text-muted-foreground">{d.customer} ↔ {d.technician} · {fmtRelative(d.ts, lang)}{d.amount > 0 && ` · ${money(d.amount)}`}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => toast.info(t("admin.disputes.openingConversation"))}><MessageSquare className="mr-1 size-3.5" /> {t("admin.disputes.message")}</Button>
                {d.status !== "resolved" ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => escalate(d.id)}><Clock className="mr-1 size-3.5" /> {t("admin.disputes.escalate")}</Button>
                    <Button size="sm" className="bg-emerald-glow text-black hover:bg-emerald-glow/90" onClick={() => resolve(d.id)}><CheckCircle2 className="mr-1 size-3.5" /> {t("admin.disputes.resolve")}</Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => toast.info(t("admin.disputes.reopening"))}><XCircle className="mr-1 size-3.5" /> {t("admin.disputes.reopen")}</Button>
                )}
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
