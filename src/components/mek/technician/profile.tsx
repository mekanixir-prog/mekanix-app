"use client";
import { useState } from "react";
import type { DemoUser } from "@/lib/use-active-user";
import { SectionHeader } from "@/components/mek/shared/primitives";
import { MekIcon, iconForCategory } from "@/components/mek/shared/icons";
import { StarRating } from "@/components/mek/shared/primitives";
import { TECH_LEVELS, SERVICE_CATEGORIES } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, BadgeCheck, Plus, Wrench, Star } from "lucide-react";
import { toast } from "sonner";
import { useT } from "@/lib/use-t";
import { toPersianDigits } from "@/lib/format";

export function TechnicianProfile({ user }: { user: DemoUser }) {
  const { t, isFa, cat, money } = useT();
  const tech = user.technician!;
  const level = TECH_LEVELS.find((l) => l.slug === tech.level) ?? TECH_LEVELS[0];
  const [bio, setBio] = useState(tech.bio ?? "");
  const [hourlyRate, setHourlyRate] = useState(String(tech.hourlyRate));
  const [specs, setSpecs] = useState<string[]>(tech.specialties.map((s) => s.category));

  const toggleSpec = (slug: string) => {
    setSpecs((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));
  };

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <SectionHeader title={t("tech.profile.title")} subtitle={t("tech.profile.subtitle")} action={<Button className="bg-amber text-black hover:bg-amber/90" onClick={() => toast.success(t("tech.profile.saved"))}>{t("tech.profile.save")}</Button>} />

      {/* Header card */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5">
        <div className="absolute -right-16 -top-16 size-48 rounded-full bg-amber/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative shrink-0">
            <div className="grid size-20 place-items-center overflow-hidden rounded-2xl border border-border bg-muted">
              {user.avatar ? <img src={user.avatar} alt="" className="size-full object-cover" /> : <span className="font-display text-2xl">{user.name[0]}</span>}
            </div>
            {tech.verified && <div className="absolute -bottom-1 -right-1 grid size-7 place-items-center rounded-full border-2 border-card bg-amber text-black"><BadgeCheck className="size-4" /></div>}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-semibold">{user.name}</h1>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase" style={{ background: `${level.color}22`, color: level.color }}>{t(`level.${level.slug}`, level.label)}</span>
              {tech.verified && <span className="rounded-full bg-emerald-glow/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-glow">{t("tech.profile.verified")}</span>}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <StarRating value={Number(tech.rating)} />
              <span className="font-semibold">{isFa ? toPersianDigits(Number(tech.rating).toFixed(2)) : Number(tech.rating).toFixed(2)}</span>
              <span className="text-muted-foreground">· {isFa ? toPersianDigits(tech.reviewCount) : tech.reviewCount} {t("tech.profile.reviews")} · {isFa ? toPersianDigits(tech.completedJobs) : tech.completedJobs} {t("tech.profile.jobs")} · {isFa ? toPersianDigits(tech.experienceYears) : tech.experienceYears} {t("common.yrs")}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Wrench className="size-3 text-amber" /> {money(Number(tech.hourlyRate))}/{t("common.hr")}</span>
              <span className="inline-flex items-center gap-1"><Star className="size-3 text-amber" /> {t(`level.${tech.level}`, tech.level)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">{t("tech.profile.bioRates")}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">{t("tech.profile.bio")}</Label>
              <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">{t("tech.profile.hourlyRate")}</Label>
                <Input value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} type="number" className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">{t("tech.profile.travelFee")}</Label>
                <Input defaultValue={String(tech.travelFeeBase)} type="number" className="mt-1" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">{t("tech.profile.specialties")}</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {SERVICE_CATEGORIES.map((c) => (
                <button
                  key={c.slug}
                  onClick={() => toggleSpec(c.slug)}
                  className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors ${specs.includes(c.slug) ? "border-amber bg-amber/10" : "border-border hover:bg-accent"}`}
                >
                  <MekIcon name={c.icon} className={`size-4 ${specs.includes(c.slug) ? "text-amber" : "text-muted-foreground"}`} />
                  <span className="text-[11px] font-medium leading-tight">{cat(c.slug)}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2"><ShieldCheck className="size-4 text-amber" /> {t("tech.profile.certifications")}</span>
            <Button variant="outline" size="sm" onClick={() => toast.info(t("tech.profile.addCertDesc"))}><Plus className="mr-1 size-3.5" /> {t("tech.profile.addCert")}</Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tech.certifications.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
              <div className={`grid size-9 place-items-center rounded-lg border ${c.verified ? "border-emerald-glow/30 bg-emerald-glow/10" : "border-border bg-muted"}`}>
                <ShieldCheck className={`size-4 ${c.verified ? "text-emerald-glow" : "text-muted-foreground"}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">{c.issuer} · {isFa ? toPersianDigits(c.year) : c.year}</p>
              </div>
              <Badge variant={c.verified ? "default" : "secondary"} className={c.verified ? "bg-emerald-glow/15 text-emerald-glow" : ""}>{c.verified ? t("tech.profile.verified") : t("tech.profile.pending")}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
