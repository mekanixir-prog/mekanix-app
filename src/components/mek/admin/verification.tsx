"use client";
import { useEffect, useState } from "react";
import { ShieldCheck, Loader2, BadgeCheck, FileText, Clock } from "lucide-react";
import { api, type Technician } from "@/lib/api";
import { SectionHeader, EmptyState, StarRating } from "@/components/mek/shared/primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";
import { toPersianDigits } from "@/lib/format";

export function AdminVerification() {
  const { t, isFa } = useT();
  const [rows, setRows] = useState<Technician[] | null>(null);

  const load = () => { api.adminList("technicians").then(setRows).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);

  const verifyTech = async (tk: Technician) => {
    await api.adminUpdate("technicians", tk.id, { verified: !tk.verified });
    toast.success(tk.verified ? t("admin.technicians.unverifiedToastName").replace("{name}", tk.user.name) : t("admin.technicians.verifiedToastName").replace("{name}", tk.user.name));
    load();
  };
  const verifyCert = async (tk: Technician, certId: string, verified: boolean) => {
    // Update certification via technician update (certifications are nested; use direct patch through admin)
    try {
      await api.adminUpdate("technicians", tk.id, { certifications: { update: { where: { id: certId }, data: { verified: !verified } } } } as any);
      toast.success(t("admin.verification.certUpdated"));
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  // technicians with pending certifications or unverified
  const queue = (rows ?? []).filter((tk) => !tk.verified || tk.certifications.some((c) => !c.verified));

  return (
    <div className="space-y-4" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.verification.title")} subtitle={t("admin.verification.subtitle")} />
      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : queue.length === 0 ? (
        <EmptyState icon={BadgeCheck} title={t("admin.verification.queueClear")} description={t("admin.verification.queueClearDesc")} />
      ) : (
        <div className="space-y-3">
          {queue.map((tk) => (
            <div key={tk.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="grid size-11 place-items-center overflow-hidden rounded-xl border border-border bg-muted">
                    {tk.user.avatar ? <img src={tk.user.avatar} alt="" className="size-full object-cover" /> : <span className="font-semibold">{tk.user.name[0]}</span>}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{tk.user.name}</p>
                      <Badge variant={tk.verified ? "default" : "secondary"} className={tk.verified ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{tk.verified ? t("common.verified") : t("common.pending")}</Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t("common.specialtiesCount").replace("{n}", isFa ? toPersianDigits(tk.specialties.length) : String(tk.specialties.length))} · {isFa ? toPersianDigits(tk.experienceYears) : tk.experienceYears} {t("common.yrsShort")} · <span className="inline-flex items-center gap-1"><StarRating value={Number(tk.rating)} size={10} />{isFa ? toPersianDigits(Number(tk.rating).toFixed(1)) : Number(tk.rating).toFixed(1)}</span></p>
                  </div>
                </div>
                <Button size="sm" variant={tk.verified ? "outline" : "default"} className={tk.verified ? "" : "bg-emerald-glow text-black hover:bg-emerald-glow/90"} onClick={() => verifyTech(tk)}>
                  {tk.verified ? t("admin.verification.revokeVerification") : t("admin.verification.verifyTech")}
                </Button>
              </div>

              {tk.certifications.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                  {tk.certifications.map((c) => (
                    <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2">
                      <div className={`grid size-8 place-items-center rounded-lg border ${c.verified ? "border-emerald-glow/30 bg-emerald-glow/10" : "border-amber/30 bg-amber/10"}`}>
                        {c.verified ? <BadgeCheck className="size-4 text-emerald-glow" /> : <Clock className="size-4 text-amber" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{c.name}</p>
                        <p className="text-[11px] text-muted-foreground">{c.issuer} · {isFa ? toPersianDigits(c.year) : c.year}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => verifyCert(tk, c.id, c.verified)}>
                        {c.verified ? t("admin.verification.revoke") : t("admin.verification.approveBtn")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
