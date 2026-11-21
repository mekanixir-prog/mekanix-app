"use client";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Star, MapPin, Clock, BadgeCheck, ChevronRight } from "lucide-react";
import type { Technician } from "@/lib/api";
import { StarRating } from "./primitives";
import { TECH_LEVELS } from "@/lib/constants";
import { fmtDistance, fmtDuration, haversine, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

export function TechnicianCard({
  tech,
  distanceKm,
  etaMins,
  onSelect,
  selected,
  rank,
  inspectionFee,
  travelFee,
  className,
}: {
  tech: Technician;
  distanceKm?: number;
  etaMins?: number;
  onSelect?: () => void;
  selected?: boolean;
  rank?: number;
  inspectionFee?: number;
  travelFee?: number;
  className?: string;
}) {
  const { t, isFa, money } = useT();
  const lang = isFa ? "fa" : "en";
  const level = TECH_LEVELS.find((l) => l.slug === tech.level) ?? TECH_LEVELS[0];
  const hasFees = inspectionFee != null || travelFee != null;
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      dir={isFa ? "rtl" : "ltr"}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className={cn(
        "group relative w-full overflow-hidden rounded-xl border bg-card p-4 text-left transition-colors mk-card-hover",
        selected ? "border-amber mk-amber-glow" : "border-border hover:border-amber/40",
        className
      )}
    >
      {rank != null && (
        <div className="absolute right-3 top-3 grid size-6 place-items-center rounded-md border border-border bg-background font-mono text-[10px] font-bold text-amber">
          #{rank}
        </div>
      )}
      <div className="flex gap-3">
        <div className="relative shrink-0">
          <div className="grid size-12 place-items-center overflow-hidden rounded-xl border border-border bg-muted">
            {tech.user.avatar ? (
              <img src={tech.user.avatar} alt={tech.user.name} className="size-full object-cover" />
            ) : (
              <span className="font-display text-sm font-semibold">{tech.user.name[0]}</span>
            )}
          </div>
          {tech.verified && (
            <div className="absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border-2 border-card bg-amber text-black">
              <BadgeCheck className="size-3" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-display text-sm font-semibold">{tech.user.name}</h3>
            <span className="font-mono text-[9px] uppercase tracking-wide" style={{ color: level.color }}>{level.label}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <StarRating value={Number(tech.rating)} size={11} />
            <span className="font-medium text-foreground">{isFa ? toPersianDigits(Number(tech.rating).toFixed(1)) : Number(tech.rating).toFixed(1)}</span>
            <span>·</span>
            <span>{isFa ? toPersianDigits(tech.completedJobs) : tech.completedJobs} {t("common.jobs")}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {tech.specialties.slice(0, 2).map((s) => (
              <span key={s.id} className="rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {s.label}
              </span>
            ))}
            {tech.specialties.length > 2 && (
              <span className="rounded px-1 text-[10px] text-muted-foreground">+{tech.specialties.length - 2}</span>
            )}
          </div>
        </div>
      </div>

      {/* Fees strip (optional — shown when inspectionFee/travelFee provided) */}
      {hasFees && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5 text-[10px]">
          {inspectionFee != null && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span>{t("fees.inspectionFee")}:</span>
              <span className="font-medium text-foreground">{money(inspectionFee)}</span>
            </span>
          )}
          {travelFee != null && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span>{t("fees.travelFee")}:</span>
              <span className="font-medium text-foreground">{money(travelFee)}</span>
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-[11px]">
        <div className="flex items-center gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3 text-amber" />
            {distanceKm != null ? fmtDistance(distanceKm, lang) : "—"}
          </span>
          {etaMins != null && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3 text-amber" />
              {fmtDuration(etaMins, lang)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-display text-sm font-semibold">{money(Number(tech.hourlyRate))}<span className="text-[10px] text-muted-foreground">/{t("common.hr")}</span></span>
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
      {selected && (
        <motion.div
          layoutId="tech-selected"
          className="absolute inset-x-0 bottom-0 h-0.5 bg-amber"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        />
      )}
    </motion.button>
  );
}

export function TechnicianMini({ tech }: { tech: Technician }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid size-8 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
        {tech.user.avatar ? (
          <img src={tech.user.avatar} alt={tech.user.name} className="size-full object-cover" />
        ) : (
          <span className="text-[11px] font-semibold">{tech.user.name[0]}</span>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{tech.user.name}</p>
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Star className="size-2.5 fill-amber text-amber" /> {tech.rating.toFixed(1)}
        </p>
      </div>
    </div>
  );
}
