"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Receipt, Loader2, CreditCard, Wallet, Landmark, Banknote, ShieldCheck, CheckCircle2, ArrowLeft, Lock, FileText,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Invoice, type Job, type Payment } from "@/lib/api";
import { PAYMENT_METHODS } from "@/lib/constants";
import { fmtDate, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { parseMedia } from "@/lib/format";

export function CustomerInvoice({ customer }: { customer: DemoUser }) {
  const { go, params, back } = useApp();
  const { t, isFa, money } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState("card");
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!params.jobId) return;
    api.getJob(params.jobId).then(async (j) => {
      setJob(j);
      const inv = await api.getInvoice(j.id);
      setInvoice(inv);
    }).catch(() => toast.error(t("invoice.jobNotFound"))).finally(() => setLoading(false));
  }, [params.jobId]);

  const approveAndPay = async () => {
    if (!invoice) return;
    setPaying(true);
    try {
      // approve first (if waiting)
      if (job && !job.customerApproved && job.status === "WAITING_APPROVAL") {
        const updated = await api.updateJobStatus(job.id, job.status, { customerApproved: true });
        setJob(updated);
      }
      const pay = await api.payInvoice(invoice.id, method);
      if (pay.status === "SUCCEEDED") {
        toast.success(t("pay.success"));
        go("completion", { jobId: job!.id });
      } else {
        toast.error(t("pay.failed"));
      }
    } catch (e: any) {
      toast.error(e.message ?? t("pay.failed"));
    } finally {
      setPaying(false);
    }
  };

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!job) return null;

  const parts = job.parts;
  const mediaUrls = parseMedia(job.request.mediaUrls);
  const financialReady = invoice?.financialUnitStatus === "VERIFIED_IRR" && invoice.total != null;

  return (
    <div className="mx-auto max-w-3xl space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <button onClick={back} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t("invoice.back")}
      </button>

      {/* Invoice header */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-amber/10 to-transparent px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="grid size-9 place-items-center rounded-lg border border-amber/30 bg-amber/10">
              <Receipt className="size-4 text-amber" />
            </div>
            <div>
              <h1 className="font-display text-base font-semibold">{t("invoice.title")}</h1>
              <p className="font-mono text-[11px] text-muted-foreground">{isFa ? toPersianDigits(invoice?.code ?? t("invoice.draft")) : (invoice?.code ?? t("invoice.draft"))} · {isFa ? toPersianDigits(job.code) : job.code}</p>
            </div>
          </div>
          {invoice && (
            <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${invoice.status === "PAID" ? "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow" : invoice.status === "SENT" ? "border-amber/30 bg-amber/10 text-amber" : "border-border text-muted-foreground"}`}>
              {t(`invst.${invoice.status}`)}
            </span>
          )}
        </div>

        {/* Diagnosis & parts summary */}
        <div className="space-y-4 p-5">
          {job.diagnosis && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("invoice.diagnosis")}</p>
              <p className="mt-1 text-sm">{job.diagnosis}</p>
            </div>
          )}

          {/* Parts */}
          {parts.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("invoice.parts")}</p>
              <div className="mt-2 overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t("invoice.col.item")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("invoice.col.qty")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("invoice.col.unit")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("invoice.col.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={p.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">{p.name}</span>
                          {p.sku && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{p.sku}</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{isFa ? toPersianDigits(p.quantity) : p.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(p.unitPrice == null ? null : Number(p.unitPrice))}</td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{money(p.unitPrice == null ? null : Number(p.unitPrice) * p.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Media evidence */}
          {mediaUrls.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("invoice.diagnosticPhotos")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {mediaUrls.map((u, i) => <img key={i} src={u} alt="" className="size-20 rounded-lg border border-border object-cover" />)}
              </div>
            </div>
          )}
        </div>

        {/* Totals */}
        {invoice && (
          <div className="border-t border-border bg-muted/20 p-5">
            <div className="mx-auto max-w-xs space-y-1.5 text-sm">
              <Line label={t("invoice.labor")} value={`${isFa ? toPersianDigits(invoice.laborHours) : invoice.laborHours}${t("common.hourShort")} × ${money(invoice.laborRate == null ? null : Number(invoice.laborRate))}`} amount={invoice.laborTotal == null ? null : Number(invoice.laborTotal)} moneyFn={money} />
              <Line label={t("invoice.partsMaterials")} amount={invoice.partsTotal == null ? null : Number(invoice.partsTotal)} moneyFn={money} />
              <Line label={t("invoice.travelFee")} amount={invoice.travelFee == null ? null : Number(invoice.travelFee)} moneyFn={money} />
              <div className="border-t border-border pt-1.5" />
              <Line label={t("invoice.subtotal")} amount={invoice.subtotal == null ? null : Number(invoice.subtotal)} muted moneyFn={money} />
              <Line label={t("invoice.tax", undefined).replace("{rate}", isFa ? toPersianDigits(Math.round(Number(invoice.taxRate) * 100)) : String(Math.round(Number(invoice.taxRate) * 100)))} amount={invoice.taxTotal == null ? null : Number(invoice.taxTotal)} muted moneyFn={money} />
              {Number(invoice.discount) > 0 && <Line label={t("invoice.discount")} amount={-Number(invoice.discount)} muted tone="emerald" moneyFn={money} />}
              <div className="flex items-center justify-between border-t border-border pt-2">
                <span className="font-display text-base font-semibold">{t("invoice.total")}</span>
                <span className="font-display text-xl font-bold text-amber">{money(invoice.total == null ? null : Number(invoice.total))}</span>
              </div>
            </div>
          </div>
        )}

        {invoice?.notes && <p className="px-5 pb-3 text-[11px] text-muted-foreground">{invoice.notes}</p>}
      </div>

      {/* Payment */}
      {invoice && !financialReady && invoice.status !== "PAID" && (
        <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-muted-foreground">
          {isFa ? "مبالغ این فاکتور تا تأیید منشأ مالی قابل نمایش یا پرداخت نیستند." : "Invoice amounts are unavailable until their financial provenance is verified."}
        </div>
      )}

      {invoice && invoice.status !== "PAID" && financialReady && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-amber" />
            <h3 className="font-display text-sm font-semibold">{t("invoice.approvePay")}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("invoice.approvePayHint")}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PAYMENT_METHODS.map((m) => {
              const Icon = { CreditCard, Wallet, Landmark, Banknote }[m.icon] ?? CreditCard;
              return (
                <button
                  key={m.slug}
                  onClick={() => setMethod(m.slug)}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors ${method === m.slug ? "border-amber bg-amber/10" : "border-border hover:bg-accent"}`}
                >
                  <Icon className={`size-5 ${method === m.slug ? "text-amber" : "text-muted-foreground"}`} />
                  <span className="text-[10px] font-medium leading-tight">{t(`pay.${m.slug}`)}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-glow/20 bg-emerald-glow/5 p-3 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-glow shrink-0" />
            {t("invoice.securePayment")}
          </div>

          <Button onClick={approveAndPay} disabled={paying} className="mt-3 w-full bg-amber text-black hover:bg-amber/90">
            {paying ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Lock className="mr-2 size-4" />}
            {t("pay.approveAndPay")} {money(Number(invoice.total))}
          </Button>
        </div>
      )}

      {invoice?.status === "PAID" && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-emerald-glow/40 bg-emerald-glow/5 p-5">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-glow" />
            <h3 className="font-display text-sm font-semibold">{t("invoice.paymentComplete")}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("invoice.paidOn").replace("{amount}", money(Number(invoice.total))).replace("{date}", fmtDate(invoice.updatedAt, undefined, isFa ? "fa" : "en"))}
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => go("invoice-document", { jobId: job.id })} variant="outline" className="flex-1">
              <FileText className="mr-1.5 size-4" /> {t("invoice.viewInvoiceDoc")}
            </Button>
            <Button onClick={() => go("completion", { jobId: job.id })} className="flex-1 bg-amber text-black hover:bg-amber/90">
              {t("invoice.viewSummary")}
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

function Line({ label, value, amount, muted, tone, moneyFn }: { label: string; value?: string; amount: number | null; muted?: boolean; tone?: string; moneyFn: (n: unknown) => string }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted-foreground" : "text-foreground"}>
        {label}{value && <span className="ml-1 text-[11px] text-muted-foreground">{value}</span>}
      </span>
      <span className={`tabular-nums ${tone === "emerald" ? "text-emerald-glow" : muted ? "text-muted-foreground" : "font-medium"}`}>
        {moneyFn(amount)}
      </span>
    </div>
  );
}
