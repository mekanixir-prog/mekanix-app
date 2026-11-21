"use client";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import { haversine, fmtDistance, fmtDuration } from "@/lib/format";

// Real Leaflet map loaded dynamically (ssr:false) — Leaflet needs window.
// Uses OpenStreetMap tiles which work in Iran (no Google Maps dependency).
const LeafletMap = dynamic(() => import("./leaflet-map").then((m) => m.LeafletMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-muted-foreground">Loading map…</div>,
});

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  kind: "customer" | "technician" | "active-job" | "service-area";
  label?: string;
  tone?: string;
}

export function MapView({
  points,
  route,
  center,
  className,
  height = 360,
  showGrid = true,
  children,
}: {
  points?: MapPoint[];
  route?: { lat: number; lng: number }[];
  center?: { lat: number; lng: number };
  className?: string;
  height?: number;
  showGrid?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-xl border border-border", className)}
      style={{ height }}
    >
      <LeafletMap points={points} route={route} center={center} height={height} />
      {children}
      <div className="absolute right-3 top-3 z-[1000] grid size-8 place-items-center rounded-lg border border-border bg-background/70 backdrop-blur">
        <span className="font-mono text-[9px] text-muted-foreground">N</span>
      </div>
    </div>
  );
}

export function routeInfo(a: { lat: number; lng: number }, b: { lat: number; lng: number }, lang: "en" | "fa" = "en") {
  const km = haversine(a, b);
  // assume ~35 km/h urban avg
  const mins = Math.max(3, Math.round((km / 35) * 60));
  return { km, mins, label: `${fmtDistance(km, lang)} · ${fmtDuration(mins, lang)}` };
}
