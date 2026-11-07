"use client";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { MapPin, Gauge, Calendar, Trash2 } from "lucide-react";
import type { Vehicle } from "@/lib/api";
import { iconForMachineType } from "./icons";
import { MekIcon } from "./icons";
import { fmtDate, toPersianDigits } from "@/lib/format";
import { useT } from "@/lib/use-t";

export function VehicleCard({
  vehicle,
  onSelect,
  selected,
  onDelete,
  className,
}: {
  vehicle: Vehicle;
  onSelect?: () => void;
  selected?: boolean;
  onDelete?: () => void;
  className?: string;
}) {
  const { t, isFa, type: typeLabel, lang } = useT();
  const iconName = iconForMachineType(vehicle.type);
  const serviceEligible = isVehicleInSupportedScope(vehicle.type, vehicle.make);
  return (
    <motion.button
      type="button"
      onClick={serviceEligible ? onSelect : undefined}
      aria-disabled={!serviceEligible}
      dir={isFa ? "rtl" : "ltr"}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className={cn(
        "group relative w-full overflow-hidden rounded-xl border bg-card p-4 text-left mk-card-hover",
        selected ? "border-amber mk-amber-glow" : "border-border hover:border-amber/40",
        !serviceEligible && "cursor-not-allowed opacity-75",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl border border-border bg-gradient-to-br from-background to-muted/60">
          <MekIcon name={iconName} className="size-5 text-amber" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
              {typeLabel(vehicle.type)}
            </span>
            {vehicle.plate && (
              <span className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                {vehicle.plate}
              </span>
            )}
          </div>
          <h3 className="mt-1 truncate font-display text-sm font-semibold">
            {vehicle.make} {vehicle.model}
          </h3>
          <p className="text-[11px] text-muted-foreground">{isFa ? toPersianDigits(vehicle.year) : vehicle.year}</p>
          {!serviceEligible && (
            <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
              {isFa ? "خارج از محدوده خدمات سواری" : "Outside passenger service scope"}
            </p>
          )}
        </div>
        {onDelete && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[11px] text-muted-foreground">
        {vehicle.location && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="size-3 text-amber" /> {vehicle.location}
          </span>
        )}
        {vehicle.engineHours != null && (
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3 text-amber" /> {isFa ? toPersianDigits(vehicle.engineHours.toLocaleString("en-US")) : vehicle.engineHours.toLocaleString()} {t("common.hrs")}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Calendar className="size-3 text-amber" /> {t("common.added")} {fmtDate(vehicle.createdAt, undefined, lang)}
        </span>
      </div>
    </motion.button>
  );
}
