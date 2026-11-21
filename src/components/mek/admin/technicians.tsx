"use client";
import { useEffect, useState } from "react";
import { Wrench, Loader2, BadgeCheck } from "lucide-react";
import { api, type Technician } from "@/lib/api";
import { AdminTable, type Column } from "@/components/mek/shared/admin-table";
import { StarRating, SectionHeader, EmptyState } from "@/components/mek/shared/primitives";
import { TECH_LEVELS } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";

export function AdminTechnicians() {
  const { t, isFa, money, lang } = useT();
  const [rows, setRows] = useState<Technician[] | null>(null);

  const load = () => { api.adminList("technicians").then(setRows).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);

  const toggleVerify = async (tech: Technician) => {
    setRows((prev) => prev?.map((x) => x.id === tech.id ? { ...x, verified: !x.verified } : x) ?? null);
    try {
      await api.adminUpdate("technicians", tech.id, { verified: !tech.verified });
      toast.success(tech.verified ? t("admin.technicians.unverifiedToastName").replace("{name}", tech.user.name) : t("admin.technicians.verifiedToastName").replace("{name}", tech.user.name));
    } catch {
      toast.error(t("admin.technicians.updateFailed"));
      load();
    }
  };

  const fmtCount = (n: number) => (isFa ? toPersianDigits(n) : String(n));

  const columns: Column<Technician>[] = [
    {
      key: "name",
      header: t("admin.technicians.col.technician"),
      sortValue: (tk) => tk.user.name,
      cell: (tk) => (
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center overflow-hidden rounded-full border border-border bg-muted">
            {tk.user.avatar ? <img src={tk.user.avatar} alt="" className="size-full object-cover" /> : <span className="text-[10px]">{tk.user.name[0]}</span>}
          </div>
          <div>
            <p className="font-medium">{tk.user.name}</p>
            <p className="text-[11px] text-muted-foreground">{t("common.specialtiesCount").replace("{n}", fmtCount(tk.specialties.length))}</p>
          </div>
        </div>
      ),
    },
    { key: "level", header: t("admin.technicians.col.level"), cell: (tk) => { const l = TECH_LEVELS.find((x) => x.slug === tk.level) ?? TECH_LEVELS[0]; return <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: `${l.color}22`, color: l.color }}>{t(`level.${l.slug}`, l.label)}</span>; }, sortValue: (tk) => tk.level },
    { key: "rating", header: t("admin.technicians.col.rating"), cell: (tk) => <span className="inline-flex items-center gap-1"><StarRating value={Number(tk.rating)} size={11} /><span className="tabular-nums">{isFa ? toPersianDigits(Number(tk.rating).toFixed(1)) : Number(tk.rating).toFixed(1)}</span></span>, sortValue: (tk) => Number(tk.rating) },
    { key: "jobs", header: t("admin.technicians.col.jobs"), cell: (tk) => <span className="tabular-nums">{fmtCount(tk.completedJobs)}</span>, sortValue: (tk) => tk.completedJobs },
    { key: "rate", header: t("admin.technicians.col.rate"), cell: (tk) => <span className="tabular-nums">{money(Number(tk.hourlyRate))}/{t("common.hr")}</span>, sortValue: (tk) => Number(tk.hourlyRate) },
    { key: "status", header: t("admin.technicians.col.online"), cell: (tk) => <Badge variant={tk.status === "ONLINE" ? "default" : "secondary"} className={tk.status === "ONLINE" ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{t(`common.${tk.status === "ONLINE" ? "online" : "offline"}`, tk.status)}</Badge> },
    { key: "verified", header: t("admin.technicians.col.verified"), cell: (tk) => <div onClick={(e) => e.stopPropagation()}><Switch checked={tk.verified} onCheckedChange={() => toggleVerify(tk)} /></div> },
  ];

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.technicians.title")} subtitle={t("admin.technicians.subtitle2")} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Wrench} title={t("admin.technicians.empty")} />
      ) : (
        <AdminTable data={rows} columns={columns} searchable searchKeys={["user"]} pageSize={12} emptyIcon={Wrench} />
      )}
    </div>
  );
}
