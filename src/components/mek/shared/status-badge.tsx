"use client";
import { cn } from "@/lib/utils";
import { JOB_STATUS_FLOW, STATUS_TONE_CLASS, URGENCY } from "@/lib/constants";
import { useT } from "@/lib/use-t";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useT();
  const meta = JOB_STATUS_FLOW.find((s) => s.key === status) ?? { tone: "neutral", label: status };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        STATUS_TONE_CLASS[meta.tone] ?? STATUS_TONE_CLASS.neutral,
        className
      )}
    >
      <span className="size-1.5 rounded-full bg-current mk-status-pulse" />
      {t(`status.${status}`, meta.label)}
    </span>
  );
}

export function UrgencyBadge({ urgency, className }: { urgency: string; className?: string }) {
  const { t } = useT();
  const meta = URGENCY.find((u) => u.slug === urgency) ?? URGENCY[0];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", STATUS_TONE_CLASS[meta.tone], className)}>
      {t(`urgency.${urgency}`, meta.label)}
    </span>
  );
}

export function Pill({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", STATUS_TONE_CLASS[tone] ?? STATUS_TONE_CLASS.neutral, className)}>
      {children}
    </span>
  );
}
