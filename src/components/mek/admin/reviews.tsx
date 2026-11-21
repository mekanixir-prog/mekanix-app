"use client";
import { useEffect, useState } from "react";
import { Star, Loader2, Flag } from "lucide-react";
import { api, type Review } from "@/lib/api";
import { AdminTable, type Column } from "@/components/mek/shared/admin-table";
import { StarRating, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { fmtRelative, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

export function AdminReviews() {
  const { t, isFa, lang } = useT();
  const [rows, setRows] = useState<(Review & { technician: { user: { name: string } } })[] | null>(null);

  useEffect(() => {
    api.adminList("reviews").then(setRows).catch(() => setRows([]));
  }, []);

  const columns: Column<any>[] = [
    { key: "rating", header: t("admin.reviews.col.rating"), cell: (r) => <span className="inline-flex items-center gap-1"><StarRating value={r.rating} size={12} /><span className="tabular-nums">{isFa ? toPersianDigits(r.rating.toFixed(1)) : r.rating.toFixed(1)}</span></span>, sortValue: (r) => r.rating },
    { key: "customer", header: t("admin.reviews.col.from"), cell: (r) => r.fromUser?.name ?? "—", sortValue: (r) => r.fromUser?.name ?? "" },
    { key: "tech", header: t("admin.reviews.col.technician"), cell: (r) => r.technician?.user.name ?? "—", sortValue: (r) => r.technician?.user.name ?? "" },
    { key: "comment", header: t("admin.reviews.col.comment"), cell: (r) => <span className="line-clamp-2 max-w-md text-muted-foreground">{r.comment ?? "—"}</span> },
    { key: "date", header: t("admin.reviews.col.when"), cell: (r) => <span className="text-muted-foreground">{fmtRelative(r.createdAt, lang)}</span>, sortValue: (r) => new Date(r.createdAt).getTime() },
    { key: "action", header: "", cell: () => <button className="rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"><Flag className="mr-1 inline size-3" />{t("admin.reviews.flag")}</button> },
  ];

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.reviews.title")} subtitle={t("admin.reviews.subtitle")} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Star} title={t("admin.reviews.empty")} />
      ) : (
        <AdminTable data={rows} columns={columns} searchable searchKeys={["comment"]} pageSize={12} emptyIcon={Star} />
      )}
    </div>
  );
}
