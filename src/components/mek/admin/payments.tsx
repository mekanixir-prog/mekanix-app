"use client";
import { useEffect, useState } from "react";
import { CreditCard, Loader2, DollarSign, TrendingUp, CheckCircle2 } from "lucide-react";
import { api, type Payment } from "@/lib/api";
import { AdminTable, type Column } from "@/components/mek/shared/admin-table";
import { StatCard, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

export function AdminPayments() {
  const { t, isFa, money, lang } = useT();
  const [rows, setRows] = useState<(Payment & { user: { name: string }; invoice: { code: string; job?: { code: string } } })[] | null>(null);

  useEffect(() => {
    api.adminList("payments").then(setRows).catch(() => setRows([]));
  }, []);

  const succeeded = (rows ?? []).filter((p) => p.status === "SUCCEEDED");
  const total = succeeded.reduce((s, p) => s + Number(p.amount), 0);
  const failed = (rows ?? []).filter((p) => p.status === "FAILED");

  const fmtCount = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  const columns: Column<any>[] = [
    { key: "code", header: t("admin.payments.col.payment"), cell: (p) => <span className="font-mono text-[11px]">{isFa ? toPersianDigits(p.code) : p.code}</span>, sortValue: (p) => p.code },
    { key: "invoice", header: t("admin.payments.col.invoice"), cell: (p) => <span className="font-mono text-[11px] text-muted-foreground">{p.invoice?.code ? (isFa ? toPersianDigits(p.invoice.code) : p.invoice.code) : "—"}</span> },
    { key: "customer", header: t("admin.payments.col.customer"), cell: (p) => p.user?.name ?? "—", sortValue: (p) => p.user?.name ?? "" },
    { key: "amount", header: t("admin.payments.col.amount"), cell: (p) => <span className="tabular-nums font-medium text-amber">{money(p.amount)}</span>, sortValue: (p) => p.amount },
    { key: "method", header: t("admin.payments.col.method"), cell: (p) => <span>{t(`pay.${p.method}`, p.method)}</span> },
    { key: "status", header: t("admin.payments.col.status"), cell: (p) => <Badge variant={p.status === "SUCCEEDED" ? "default" : p.status === "FAILED" ? "destructive" : "secondary"} className={p.status === "SUCCEEDED" ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{t(`payst.${p.status}`, p.status)}</Badge> },
    { key: "date", header: t("admin.payments.col.date"), cell: (p) => <span className="text-muted-foreground">{fmtDateTime(p.createdAt, lang)}</span>, sortValue: (p) => new Date(p.createdAt).getTime() },
  ];

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.payments.title")} subtitle={t("admin.payments.subtitle")} />
      {rows && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={t("admin.payments.totalVolume")} value={money(total)} icon={DollarSign} tone="amber" />
          <StatCard label={t("admin.payments.successful")} value={fmtCount(succeeded.length)} icon={CheckCircle2} tone="emerald" />
          <StatCard label={t("admin.payments.failed")} value={fmtCount(failed.length)} icon={TrendingUp} tone="rose" />
          <StatCard label={t("admin.payments.avgTransaction")} value={money(succeeded.length ? total / succeeded.length : 0)} icon={CreditCard} tone="violet" />
        </div>
      )}
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={CreditCard} title={t("admin.payments.empty")} />
      ) : (
        <AdminTable data={rows} columns={columns} searchable searchKeys={["code", "user"]} pageSize={12} emptyIcon={CreditCard} />
      )}
    </div>
  );
}
