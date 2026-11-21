"use client";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
  BarChart, Bar, Cell, RadialBarChart, RadialBar, PieChart, Pie,
} from "recharts";
import { fmtMoney, toPersianDigits } from "@/lib/format";
import type { Lang } from "@/lib/i18n";

const AMBER = "oklch(0.78 0.16 68)";
const EMERALD = "oklch(0.74 0.16 160)";
const VIOLET = "oklch(0.65 0.2 300)";
const BLUE = "oklch(0.7 0.15 230)";
const ROSE = "oklch(0.66 0.21 22)";
const STEEL = "oklch(0.62 0.02 255)";

const TOOLTIP_STYLE = {
  backgroundColor: "oklch(0.18 0.008 260)",
  border: "1px solid oklch(1 0 0 / 12%)",
  borderRadius: 8,
  fontSize: 12,
  color: "oklch(0.97 0.004 95)",
} as const;

export function RevenueAreaChart({
  data,
  className,
  height = 180,
  lang = "en",
}: {
  data: { date: string; revenue: number; jobs: number }[];
  className?: string;
  height?: number;
  lang?: Lang;
}) {
  // Localize X-axis date labels when lang === "fa" (converts digits in MM/DD strings).
  const localizedData = data.map((d) => ({ ...d, date: lang === "fa" ? toPersianDigits(d.date) : d.date }));
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={localizedData} margin={{ top: 6, right: 6, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={AMBER} stopOpacity={0.45} />
              <stop offset="100%" stopColor={AMBER} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="oklch(1 0 0 / 6%)" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "oklch(0.68 0.012 260)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: "oklch(0.68 0.012 260)" }} axisLine={false} tickLine={false} tickFormatter={(v) => (lang === "fa" ? toPersianDigits(String(v)) : String(v))} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmtMoney(v, "IRR", lang)} />
          <Area type="monotone" dataKey="revenue" stroke={AMBER} strokeWidth={2} fill="url(#rev)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusBarChart({
  data,
  className,
  height = 180,
}: {
  data: { status: string; count: number }[];
  className?: string;
  height?: number;
}) {
  const colors = [STEEL, AMBER, AMBER, BLUE, VIOLET, VIOLET, AMBER, EMERALD, ROSE];
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="oklch(1 0 0 / 6%)" vertical={false} />
          <XAxis dataKey="status" tick={{ fontSize: 9, fill: "oklch(0.68 0.012 260)" }} axisLine={false} tickLine={false} interval={0} angle={-18} textAnchor="end" height={40} />
          <YAxis tick={{ fontSize: 10, fill: "oklch(0.68 0.012 260)" }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "oklch(1 0 0 / 4%)" }} />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryPieChart({
  data,
  className,
  height = 200,
}: {
  data: { category: string; count: number }[];
  className?: string;
  height?: number;
}) {
  const colors = [AMBER, EMERALD, BLUE, VIOLET, ROSE, STEEL, "oklch(0.6 0.15 160)", "oklch(0.55 0.13 290)"];
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="count" nameKey="category" innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="none">
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SatisfactionRadial({
  value,
  className,
  size = 120,
  lang = "en",
}: {
  value: number;
  className?: string;
  size?: number;
  lang?: Lang;
}) {
  const pct = (value / 5) * 100;
  const data = [{ name: "sat", value: pct, fill: AMBER }];
  const display = value.toFixed(1);
  const maxDisplay = lang === "fa" ? toPersianDigits("5.0") : "5.0";
  return (
    <div className={cn("relative", className)} style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart innerRadius="68%" outerRadius="100%" data={data} startAngle={90} endAngle={-270}>
          <RadialBar dataKey="value" background={{ fill: "oklch(1 0 0 / 8%)" }} cornerRadius={20} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <p className="font-display text-xl font-bold text-amber">{lang === "fa" ? toPersianDigits(display) : display}</p>
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">/ {maxDisplay}</p>
        </div>
      </div>
    </div>
  );
}

export function MiniSparkline({
  data,
  color = AMBER,
  className,
  height = 36,
}: {
  data: number[];
  color?: string;
  className?: string;
  height?: number;
}) {
  const max = Math.max(...data, 1);
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${30 - (v / max) * 28}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("w-full", className)} style={{ height }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
