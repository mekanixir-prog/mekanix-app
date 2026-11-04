"use client";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, Loader2, Download, Printer, ShieldCheck, CheckCircle2, Stamp,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Invoice } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/format";

export function InvoiceDocument({ customer }: { customer: DemoUser }) {
  const { params, back } = useApp();
  const { t, isFa, money } = useT();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params.jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const i = await api.getInvoice(params.jobId);
        if (!cancelled) setInv(i);
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [params.jobId]);

  if (loading) return <div className="grid h-64 place-items-center"><Loader2 className="size-8 animate-spin text-amber" /></div>;
  if (!inv) return <div className="p-6">{t("invoice.document.noInvoice")}</div>;

  const job = (inv as any).job;
  const parts = job?.parts ?? [];
  const tech = job?.technician;
  const cust = job?.request?.customer;
  const fmtHours = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  return (
    <div className="mx-auto max-w-3xl space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <div className="flex items-center justify-between print:hidden">
        <button onClick={back} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t("invoice.back")}
        </button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => toast.info(t("invoice.document.downloadPdf"))}><Download className="mr-1.5 size-3.5" /> {t("invoice.document.downloadBtn")}</Button>
          <Button size="sm" className="bg-amber text-black hover:bg-amber/90" onClick={() => window.print()}><Printer className="mr-1.5 size-3.5" /> {t("invoice.document.printBtn")}</Button>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-xl border border-border bg-card p-8 print:border-0 print:p-0"
      >
        {/* Watermark */}
        <div className="pointer-events-none absolute -right-10 top-10 rotate-12 select-none opacity-[0.04]">
          <span className="font-display text-[120px] font-black">{t("invoice.document.invoiceWatermark")}</span>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div className="flex items-center gap-3">
            <div className="grid size-12 place-items-center rounded-xl bg-amber/15">
              <Stamp className="size-6 text-amber" />
            </div>
            <div>
              <p className="font-display text-xl font-bold tracking-tight">MEKANIX</p>
              <p className="text-[11px] text-muted-foreground">{t("invoice.document.fieldRepair")}</p>
              <p className="font-mono text-[10px] text-muted-foreground">ops@mekanix.io · +1-415-000-0000</p>
            </div>
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("invoice.document.invoiceLabel")}</p>
            <p className="font-display text-lg font-bold">{isFa ? toPersianDigits(inv.code) : inv.code}</p>
            <span className={`mt-1 inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${inv.status === "PAID" ? "border-emerald-glow/30 bg-emerald-glow/10 text-emerald-glow" : inv.status === "SENT" ? "border-amber/30 bg-amber/10 text-amber" : "border-border text-muted-foreground"}`}>
              {t(`invst.${inv.status}`, inv.status)}
            </span>
            <p className="mt-1 text-[11px] text-muted-foreground">{t("invoice.document.issued")} {new Date(inv.createdAt).toLocaleDateString(isFa ? "fa-IR" : "en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>
        </div>

        {/* Bill to + tech */}
        <div className="grid grid-cols-2 gap-6 py-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("invoice.document.billToLabel")}</p>
            <p className="mt-1 font-display text-sm font-semibold">{cust?.user?.name ?? customer.name}</p>
            {cust?.company && <p className="text-[12px] text-muted-foreground">{cust.company}</p>}
            <p className="text-[11px] text-muted-foreground">{cust?.user?.phone}</p>
            <p className="text-[11px] text-muted-foreground">{cust?.user?.email}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("invoice.document.serviceByLabel")}</p>
            <p className="mt-1 font-display text-sm font-semibold">{tech?.user?.name ?? "—"}</p>
            {tech && <p className="text-[11px] text-muted-foreground">{tech.level} · {t("invoice.document.verified")}</p>}
            <p className="text-[11px] text-muted-foreground">{t("invoice.document.job")} {isFa ? toPersianDigits(job?.code) : job?.code}</p>
            <p className="text-[11px] text-muted-foreground">{job?.request?.vehicle?.make} {job?.request?.vehicle?.model}</p>
          </div>
        </div>

        {/* Diagnosis */}
        {job?.diagnosis && (
          <div className="rounded-lg border border-border bg-background p-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{t("invoice.document.diagnosisLabel")}</p>
            <p className="mt-1 text-sm">{job.diagnosis}</p>
          </div>
        )}

        {/* Line items */}
        <div className="mt-6 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">{t("invoice.document.descriptionCol")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("invoice.document.qtyCol")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("invoice.document.unitCol")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("invoice.document.amountCol")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="px-4 py-2.5">
                  <span className="font-medium">{t("invoice.laborFixed")}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmtHours(inv.laborHours)}{t("common.hourShort")}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.laborRate))}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.laborTotal))}</td>
              </tr>
              {Number(inv.emergencyFee) > 0 && <tr className="border-t border-border"><td className="px-4 py-2.5"><span className="font-medium">{t("invoice.emergencyFee")}</span></td><td className="px-4 py-2.5 text-right tabular-nums">1</td><td className="px-4 py-2.5 text-right tabular-nums">—</td><td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.emergencyFee))}</td></tr>}
              {parts.map((p: any) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{p.name}</span>
                    {p.sku && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{p.sku}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{isFa ? toPersianDigits(p.quantity) : p.quantity}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(p.unitPrice))}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(p.unitPrice) * p.quantity)}</td>
                </tr>
              ))}
              <tr className="border-t border-border">
                <td className="px-4 py-2.5"><span className="font-medium">{t("invoice.document.travelRow")}</span></td>
                <td className="px-4 py-2.5 text-right tabular-nums">{isFa ? toPersianDigits(1) : "1"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.travelFee))}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.travelFee))}</td>
              </tr>
              <tr className="border-t border-border">
                <td className="px-4 py-2.5"><span className="font-medium">{t("invoice.inspectionFee")}</span></td>
                <td className="px-4 py-2.5 text-right tabular-nums">{isFa ? toPersianDigits(1) : "1"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.inspectionFee))}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{money(Number(inv.inspectionFee))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="mt-4 flex justify-end">
          <div className="w-full max-w-xs space-y-1.5 text-sm">
            <Row label={t("invoice.document.subtotalLabel")} amount={Number(inv.subtotal)} muted moneyFn={money} />
            {Number(inv.discount) > 0 && <Row label={t("invoice.document.discountLabel")} amount={-Number(inv.discount)} muted tone="emerald" moneyFn={money} />}
            <Row label={t("invoice.document.taxLabel").replace("{rate}", isFa ? toPersianDigits(Math.round(Number(inv.taxRate) * 100)) : String(Math.round(Number(inv.taxRate) * 100)))} amount={Number(inv.taxTotal)} muted moneyFn={money} />
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="font-display text-base font-semibold">{t("invoice.document.totalDueLabel")}</span>
              <span className="font-display text-xl font-bold text-amber">{money(Number(inv.total))}</span>
            </div>
            {inv.payment && inv.payment.status === "SUCCEEDED" && (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 px-3 py-1.5 text-[11px] text-emerald-glow">
                <CheckCircle2 className="size-3.5" /> {t("invoice.document.paidOn").replace("{date}", new Date(inv.payment.createdAt).toLocaleDateString(isFa ? "fa-IR" : "en-US", { month: "long", day: "numeric", year: "numeric" })).replace("{method}", inv.payment.method)}
              </div>
            )}
          </div>
        </div>

        {/* Footer / warranty */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <ShieldCheck className="size-3.5 text-emerald-glow" />
            {t("invoice.document.warrantyFooter")}
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">{inv.notes ?? ""}</p>
        </div>

        {/* Signature */}
        <div className="mt-6 flex justify-between text-[10px] text-muted-foreground">
          <div>
            <div className="mb-1 h-8 w-32 border-b border-dashed border-border" />
            <p>{t("invoice.document.customerSigLabel")}</p>
          </div>
          <div className="text-right">
            <div className="mb-1 h-8 w-32 border-b border-dashed border-border" />
            <p>{t("invoice.document.technicianSigLabel").replace("{name}", tech?.user?.name ?? "")}</p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function Row({ label, amount, muted, tone, moneyFn }: { label: string; amount: number; muted?: boolean; tone?: string; moneyFn: (n: number) => string }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted-foreground" : ""}>{label}</span>
      <span className={`tabular-nums ${tone === "emerald" ? "text-emerald-glow" : muted ? "text-muted-foreground" : "font-medium"}`}>{moneyFn(amount)}</span>
    </div>
  );
}
