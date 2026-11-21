"use client";
import { useEffect, useState } from "react";
import { Briefcase, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { AdminTable, type Column } from "@/components/mek/shared/admin-table";
import { StatusBadge, UrgencyBadge } from "@/components/mek/shared/status-badge";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { fmtDate, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

type JobRow = {
  id: string; code: string; status: string;
  request: { title: string; urgency: string; customer: { user: { name: string } }; vehicle: { make: string; model: string; type: string } };
  technician: { user: { name: string } } | null;
  invoice: { total: number; status: string } | null;
  createdAt: string; completedAt: string | null;
};

export function AdminJobs() {
  const { t, isFa, money, lang } = useT();
  const [rows, setRows] = useState<JobRow[] | null>(null);

  useEffect(() => {
    api.adminList("jobs").then(setRows).catch(() => setRows([]));
  }, []);

  const columns: Column<JobRow>[] = [
    { key: "code", header: t("admin.jobs.col.code"), cell: (r) => <span className="font-mono text-[11px]">{isFa ? toPersianDigits(r.code) : r.code}</span>, sortValue: (r) => r.code },
    { key: "title", header: t("admin.jobs.col.title"), cell: (r) => (<div><p className="font-medium">{r.request.title}</p><p className="text-[11px] text-muted-foreground">{r.request.vehicle.make} {r.request.vehicle.model}</p></div>), sortValue: (r) => r.request.title },
    { key: "customer", header: t("admin.jobs.col.customer"), cell: (r) => r.request.customer.user.name, sortValue: (r) => r.request.customer.user.name },
    { key: "tech", header: t("admin.jobs.col.technician"), cell: (r) => r.technician?.user.name ?? <span className="text-muted-foreground">{t("admin.jobs.unassigned")}</span>, sortValue: (r) => r.technician?.user.name ?? "" },
    { key: "urgency", header: t("admin.jobs.col.urgency"), cell: (r) => <UrgencyBadge urgency={r.request.urgency} /> },
    { key: "status", header: t("admin.jobs.col.status"), cell: (r) => <StatusBadge status={r.status} /> },
    { key: "total", header: t("admin.jobs.col.total"), cell: (r) => r.invoice ? <span className="tabular-nums text-amber">{money(r.invoice.total)}</span> : <span className="text-muted-foreground">—</span>, sortValue: (r) => r.invoice?.total ?? 0 },
    { key: "date", header: t("admin.jobs.col.created"), cell: (r) => <span className="text-muted-foreground">{fmtDate(r.createdAt, undefined, lang)}</span>, sortValue: (r) => new Date(r.createdAt).getTime() },
  ];

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.jobs.title")} subtitle={t("admin.jobs.subtitle2")} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Briefcase} title={t("admin.jobs.empty")} />
      ) : (
        <AdminTable data={rows} columns={columns} searchable searchKeys={["code", "request"]} pageSize={12} emptyIcon={Briefcase} />
      )}
    </div>
  );
}
