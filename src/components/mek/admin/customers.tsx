"use client";
import { useEffect, useState } from "react";
import { Users, Loader2, Building2 } from "lucide-react";
import { api } from "@/lib/api";
import { AdminTable, type Column } from "@/components/mek/shared/admin-table";
import { fmtDate, toPersianDigits } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { useT } from "@/lib/use-t";

type Row = {
  id: string; company: string | null; user: { name: string; email: string; avatar?: string | null; status: string };
  _count: { vehicles: number; serviceRequests: number };
  createdAt: Date;
};

export function AdminCustomers() {
  const { t, isFa, lang } = useT();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api.adminList("customers").then(setRows).catch(() => setRows([]));
  }, []);

  const fmtCount = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: t("admin.customers.col.customer"),
      sortValue: (r) => r.user.name,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center overflow-hidden rounded-full border border-border bg-muted">
            {r.user.avatar ? <img src={r.user.avatar} alt="" className="size-full object-cover" /> : <span className="text-[10px]">{r.user.name[0]}</span>}
          </div>
          <div>
            <p className="font-medium">{r.user.name}</p>
            <p className="text-[11px] text-muted-foreground">{r.user.email}</p>
          </div>
        </div>
      ),
    },
    { key: "company", header: t("admin.customers.col.company"), cell: (r) => r.company ? <span className="inline-flex items-center gap-1"><Building2 className="size-3 text-muted-foreground" />{r.company}</span> : <span className="text-muted-foreground">—</span>, sortValue: (r) => r.company ?? "" },
    { key: "vehicles", header: t("admin.customers.col.machines"), cell: (r) => <span className="tabular-nums">{fmtCount(r._count.vehicles)}</span>, sortValue: (r) => r._count.vehicles },
    { key: "requests", header: t("admin.customers.col.requests"), cell: (r) => <span className="tabular-nums">{fmtCount(r._count.serviceRequests)}</span>, sortValue: (r) => r._count.serviceRequests },
    { key: "status", header: t("admin.customers.col.status"), cell: (r) => <Badge variant={r.user.status === "ACTIVE" ? "default" : "secondary"} className={r.user.status === "ACTIVE" ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{t(`common.${r.user.status === "ACTIVE" ? "active" : "inactive"}`, r.user.status)}</Badge> },
    { key: "joined", header: t("admin.customers.col.joined"), cell: (r) => <span className="text-muted-foreground">{fmtDate(r.createdAt, undefined, lang)}</span>, sortValue: (r) => new Date(r.createdAt).getTime() },
  ];

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.customers.title")} subtitle={t("admin.customers.subtitle")} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title={t("admin.customers.empty")} />
      ) : (
        <AdminTable data={rows} columns={columns} searchable searchKeys={["user"]} pageSize={12} emptyIcon={Users} />
      )}
    </div>
  );
}
