"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, Loader2, CheckCircle2, XCircle, Clock, Wrench, BadgeCheck, Phone, MapPin } from "lucide-react";
import { api } from "@/lib/api";
import { SectionHeader, EmptyState, StarRating } from "@/components/mek/shared/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { fmtRelative, toPersianDigits } from "@/lib/format";
import { toast } from "sonner";
import { MekIcon } from "@/components/mek/shared/icons";
import { useT } from "@/lib/use-t";

type Application = {
  id: string; code: string; fullName: string; phone: string; email: string | null;
  city: string | null; experienceYears: number; specialties: string; bio: string | null;
  vehicleOwned: boolean; status: string; adminNotes: string | null; createdAt: string;
  user: { id: string; name: string; technician: { id: string; rating: number; verified: boolean } | null } | null;
};

export function AdminApplications() {
  const { t, isFa, lang } = useT();
  const [rows, setRows] = useState<Application[] | null>(null);
  const [selected, setSelected] = useState<Application | null>(null);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState<string | null>(null);

  const load = () => { api.adminList("applications").then(setRows).catch(() => setRows([])); };
  useEffect(() => { load(); }, []);

  const approve = async (app: Application) => {
    setActing(app.id);
    try {
      await fetch(`/api/mechanic-applications/${app.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      toast.success(t("admin.applications.approved").replace("{name}", app.fullName));
      setSelected(null);
      setNotes("");
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(null);
    }
  };

  const reject = async (app: Application) => {
    setActing(app.id);
    try {
      await fetch(`/api/mechanic-applications/${app.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      toast.success(t("admin.applications.rejected").replace("{name}", app.fullName));
      setSelected(null);
      setNotes("");
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActing(null);
    }
  };

  const pending = (rows ?? []).filter((r) => r.status === "PENDING");
  const reviewed = (rows ?? []).filter((r) => r.status !== "PENDING");

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("admin.applications.title")} subtitle={t("admin.applications.subtitle")} />

      {rows === null ? (
        <div className="grid h-40 place-items-center"><Loader2 className="size-6 animate-spin text-amber" /></div>
      ) : (
        <>
          {/* Pending */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 font-display text-sm font-semibold">
              <Clock className="size-4 text-amber" /> {t("admin.applications.pending")}
              {pending.length > 0 && <span className="rounded-full bg-amber/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber">{isFa ? toPersianDigits(pending.length) : pending.length}</span>}
            </h3>
            {pending.length === 0 ? (
              <EmptyState icon={CheckCircle2} title={t("admin.applications.noPending")} description={t("admin.applications.noPendingDesc")} />
            ) : (
              <div className="space-y-2">
                {pending.map((app) => (
                  <ApplicationCard key={app.id} app={app} onReview={() => { setSelected(app); setNotes(""); }} />
                ))}
              </div>
            )}
          </section>

          {/* Reviewed */}
          {reviewed.length > 0 && (
            <section>
              <h3 className="mb-2 font-display text-sm font-semibold">{t("admin.applications.reviewed")}</h3>
              <div className="space-y-2">
                {reviewed.map((app) => (
                  <ApplicationCard key={app.id} app={app} onReview={() => { setSelected(app); setNotes(app.adminNotes ?? ""); }} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Detail / action dialog */}
      <Dialog open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-display">
                  <Wrench className="size-4 text-amber" /> {selected.fullName}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={selected.status === "APPROVED" ? "default" : selected.status === "REJECTED" ? "destructive" : "secondary"} className={selected.status === "APPROVED" ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{t(`appst.${selected.status}`, selected.status)}</Badge>
                  <span className="font-mono">{isFa ? toPersianDigits(selected.code) : selected.code}</span>
                  <span>· {fmtRelative(selected.createdAt, lang)}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg border border-border bg-background p-2.5">
                    <p className="text-[10px] uppercase text-muted-foreground">{t("admin.applications.col.phone")}</p>
                    <p className="font-medium">{selected.phone}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-background p-2.5">
                    <p className="text-[10px] uppercase text-muted-foreground">{t("admin.applications.col.experience")}</p>
                    <p className="font-medium">{t("admin.applications.experienceYears").replace("{n}", isFa ? toPersianDigits(selected.experienceYears) : String(selected.experienceYears))}</p>
                  </div>
                  {selected.email && (
                    <div className="rounded-lg border border-border bg-background p-2.5">
                      <p className="text-[10px] uppercase text-muted-foreground">{t("admin.applications.col.email")}</p>
                      <p className="truncate font-medium">{selected.email}</p>
                    </div>
                  )}
                  {selected.city && (
                    <div className="rounded-lg border border-border bg-background p-2.5">
                      <p className="text-[10px] uppercase text-muted-foreground">{t("mech.cityLabel")}</p>
                      <p className="font-medium">{selected.city}</p>
                    </div>
                  )}
                </div>

                {selected.specialties && (() => {
                  const specs = JSON.parse(selected.specialties) as string[];
                  return specs.length ? (
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("admin.applications.col.specialties")}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {specs.map((s) => <Badge key={s} variant="outline" className="capitalize">{t(`cat.${s}`, s.replace("-", " "))}</Badge>)}
                      </div>
                    </div>
                  ) : null;
                })()}

                {selected.bio && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("mech.about")}</p>
                    <p className="mt-1 text-sm">{selected.bio}</p>
                  </div>
                )}

                {selected.vehicleOwned && (
                  <div className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 px-2.5 py-1 text-[11px] text-emerald-glow">
                    <BadgeCheck className="size-3.5" /> {t("admin.applications.hasVehicle")}
                  </div>
                )}

                {selected.user?.technician && (
                  <div className="rounded-lg border border-emerald-glow/30 bg-emerald-glow/5 p-2.5 text-sm">
                    <p className="font-medium text-emerald-glow">{t("admin.applications.techAccount")}</p>
                    <p className="text-[11px] text-muted-foreground">{t("admin.applications.techAccountDesc").replace("{name}", selected.user.name ?? "")}</p>
                  </div>
                )}

                <div>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("admin.applications.adminNotes")} rows={2} />
                </div>

                {selected.status === "PENDING" && (
                  <DialogFooter>
                    <Button variant="outline" className="text-destructive hover:bg-destructive/10" disabled={acting === selected.id} onClick={() => reject(selected)}>
                      <XCircle className="mr-1.5 size-4" /> {t("admin.applications.reject")}
                    </Button>
                    <Button className="bg-emerald-glow text-black hover:bg-emerald-glow/90" disabled={acting === selected.id} onClick={() => approve(selected)}>
                      {acting === selected.id ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 size-4" />}
                      {t("admin.applications.approve")}
                    </Button>
                  </DialogFooter>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ApplicationCard({ app, onReview }: { app: Application; onReview: () => void }) {
  const { t, isFa, lang } = useT();
  const specs = (() => { try { return JSON.parse(app.specialties) as string[]; } catch { return []; } })();
  return (
    <motion.button
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onReview}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left mk-card-hover hover:border-amber/40"
    >
      <div className="grid size-11 shrink-0 place-items-center rounded-lg border border-border bg-background">
        <Wrench className="size-5 text-amber" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{isFa ? toPersianDigits(app.code) : app.code}</span>
          <Badge variant={app.status === "APPROVED" ? "default" : app.status === "REJECTED" ? "destructive" : "secondary"} className={app.status === "APPROVED" ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{t(`appst.${app.status}`, app.status)}</Badge>
        </div>
        <p className="mt-0.5 truncate font-medium">{app.fullName}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5"><Phone className="size-3" />{app.phone}</span>
          {app.city && <span className="inline-flex items-center gap-0.5"><MapPin className="size-3" />{app.city}</span>}
          <span>{t("admin.applications.yrsExp").replace("{n}", isFa ? toPersianDigits(app.experienceYears) : String(app.experienceYears))}</span>
          <span>· {fmtRelative(app.createdAt, lang)}</span>
        </div>
      </div>
      <div className="hidden items-center gap-1 sm:flex">
        {specs.slice(0, 2).map((s) => <span key={s} className="rounded border border-border bg-background px-1.5 py-0.5 text-[9px] text-muted-foreground">{t(`cat.${s}`, s.replace("-", " "))}</span>)}
      </div>
    </motion.button>
  );
}
