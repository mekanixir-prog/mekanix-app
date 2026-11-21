"use client";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  delta,
  icon: Icon,
  tone = "neutral",
  className,
  sub,
}: {
  label: string;
  value: string | number;
  delta?: string;
  icon?: LucideIcon;
  tone?: "neutral" | "amber" | "emerald" | "violet" | "blue" | "rose";
  className?: string;
  sub?: string;
}) {
  const toneMap: Record<string, string> = {
    neutral: "text-foreground",
    amber: "text-amber",
    emerald: "text-emerald-glow",
    violet: "text-violet-400",
    blue: "text-sky-400",
    rose: "text-destructive",
  };
  const ringMap: Record<string, string> = {
    neutral: "before:from-foreground/10",
    amber: "before:from-amber/20",
    emerald: "before:from-emerald-glow/20",
    violet: "before:from-violet-500/20",
    blue: "before:from-sky-500/20",
    rose: "before:from-destructive/20",
  };
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-4 mk-card-hover",
        "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:to-transparent",
        ringMap[tone],
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className={cn("mt-1 font-display text-2xl font-semibold tabular-nums", toneMap[tone])}>{value}</p>
          {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background/50", toneMap[tone])}>
            <Icon className="size-4" />
          </div>
        )}
      </div>
      {delta && (
        <div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          {delta}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 p-8 text-center", className)}>
      {Icon && (
        <div className="mb-3 grid size-12 place-items-center rounded-xl border border-border bg-background">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      )}
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadingBlock({ className, rows = 3 }: { className?: string; rows?: number }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-12 rounded-lg bg-muted/60 mk-shimmer" />
      ))}
    </div>
  );
}

export function StarRating({ value, size = 14, className }: { value: number; size?: number; className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" fill={i <= Math.round(value) ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} className={i <= Math.round(value) ? "text-amber" : "text-muted-foreground/40"}>
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}
