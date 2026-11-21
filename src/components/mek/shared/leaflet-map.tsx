"use client";
import { useEffect, useRef, useState } from "react";
import { Search, Loader2, MapPin, X } from "lucide-react";
import type { MapPoint } from "./map-view";

// Real Leaflet map — uses CARTO tiles (reliable, CORS-enabled, works in Iran).
// OSM standard tiles get blocked by their policy (x-blocked header).
// Loaded dynamically by MapView to avoid SSR issues (Leaflet needs window).

const TEHRAN_CENTER: [number, number] = [35.6892, 51.3890];

type SearchResult = {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
};

export function LeafletMap({
  points,
  route,
  center,
  height = 360,
  showSearch = true,
}: {
  points?: MapPoint[];
  route?: { lat: number; lng: number }[];
  center?: { lat: number; lng: number };
  height?: number;
  showSearch?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);

  // Store latest props in refs so marker updates don't re-init the map.
  const pointsRef = useRef(points);
  const routeRef = useRef(route);
  const centerRef = useRef(center);
  pointsRef.current = points;
  routeRef.current = route;
  centerRef.current = center;

  // Initialize map ONCE on mount.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;

      const p = pointsRef.current;
      const c = centerRef.current;
      const defaultCenter: [number, number] = c
        ? [c.lat, c.lng]
        : p && p[0]
        ? [p[0].lat, p[0].lng]
        : TEHRAN_CENTER;

      const map = L.map(containerRef.current, {
        center: defaultCenter,
        zoom: 13,
        zoomControl: true,
        attributionControl: true,
      });
      mapRef.current = map;

      const isDark = document.documentElement.classList.contains("dark") ||
        !document.documentElement.classList.contains("light");

      // Use OSM standard tiles (free, no API key, no watermark, works in Iran).
      // For dark mode, we add a class to the map container and use CSS to
      // apply an invert filter to the tile pane (targeting .leaflet-tile-pane).
      // This avoids CARTO's "API KEY REQUIRED" watermark on dark styled tiles.
      if (isDark && containerRef.current) {
        containerRef.current.classList.add("mek-map-dark");
      }

      const tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        subdomains: "abc",
        crossOrigin: true,
      });
      tileLayer.addTo(map);

      containerRef.current.style.background = isDark ? "#0a0b0d" : "#e8e9eb";

      // Initial markers + bounds
      updateMarkersAndBounds(L, map);
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Update markers when points/route change (without re-creating the map or
  // resetting the view). This is called on prop changes — it only adds/removes
  // markers but does NOT call fitBounds (which would jump the view back).
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    updateMarkersOnly(L, map, false);
  }, [points, route]);

  function updateMarkersAndBounds(L: any, map: any) {
    updateMarkersOnly(L, map, true);
  }

  function updateMarkersOnly(L: any, map: any, fitBounds: boolean) {
    // Clear existing markers (those we added — keep search markers)
    if (!map._mekMarkers) map._mekMarkers = [];
    map._mekMarkers.forEach((m: any) => map.removeLayer(m));
    map._mekMarkers = [];

    const allPoints = pointsRef.current ?? [];
    const bounds: [number, number][] = [];

    allPoints.forEach((p) => {
      const color =
        p.kind === "customer" ? "#F5A524"
        : p.kind === "technician" ? "#10b981"
        : p.kind === "active-job" ? "#8b5cf6"
        : "#3b82f6";

      const icon = L.divIcon({
        className: "mek-map-marker",
        html: `
          <div style="position: relative; display: grid; place-items: center;">
            ${p.kind === "technician" ? `<span style="position: absolute; width: 28px; height: 28px; border-radius: 50%; background: ${color}33; animation: mek-map-pulse 2s infinite;"></span>` : ""}
            ${p.kind === "customer" ? `<span style="position: absolute; width: 24px; height: 24px; border-radius: 50%; background: ${color}1a;"></span>` : ""}
            <div style="position: relative; width: 14px; height: 14px; border-radius: 50%; background: ${color}; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>
          </div>
        `,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });

      const marker = L.marker([p.lat, p.lng], { icon }).addTo(map);
      if (p.label) marker.bindPopup(p.label);
      map._mekMarkers.push(marker);
      bounds.push([p.lat, p.lng]);
    });

    // Draw route
    const r = routeRef.current;
    if (r && r.length > 1) {
      const latlngs = r.map((pt) => [pt.lat, pt.lng] as [number, number]);
      const polyline = L.polyline(latlngs, {
        color: "#F5A524", weight: 4, opacity: 0.8, dashArray: "6 8",
      }).addTo(map);
      map._mekMarkers.push(polyline);
      bounds.push(...latlngs);
    }

    // Only fit bounds on initial load (not on every marker update)
    if (fitBounds) {
      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 14);
      }
    }
  }

  // Geocoding search via Nominatim (free, works in Iran)
  const search = async () => {
    if (!query.trim() || !mapRef.current) return;
    setSearching(true);
    setShowResults(true);
    try {
      const q = encodeURIComponent(query.trim());
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=5&accept-language=fa`,
        { headers: { "Accept": "application/json" } }
      );
      const data = await res.json();
      setResults(Array.isArray(data) ? data : []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const flyTo = (r: SearchResult) => {
    if (!mapRef.current) return;
    const L = leafletRef.current;
    // Use setView (immediate) instead of flyTo (animated) to avoid animation
    // being interrupted by React re-renders.
    mapRef.current.setView([parseFloat(r.lat), parseFloat(r.lon)], 14);
    if (L) {
      const icon = L.divIcon({
        className: "mek-search-marker",
        html: `<div style="width: 18px; height: 18px; border-radius: 50%; background: #F5A524; border: 3px solid white; box-shadow: 0 0 8px rgba(245,165,36,0.6);"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      L.marker([parseFloat(r.lat), parseFloat(r.lon)], { icon }).addTo(mapRef.current).bindPopup(r.display_name);
    }
    setShowResults(false);
    setQuery(r.display_name.split(",")[0]);
  };

  return (
    <div className="relative" style={{ height }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%", zIndex: 0 }} />

      {/* Geocoder search box */}
      {showSearch && (
        <div className="absolute right-3 top-3 z-[1000] w-64 max-w-[calc(100%-1.5rem)]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") search(); }}
              placeholder="جستجوی آدرس... (مثلاً تهران)"
              className="w-full rounded-lg border border-border bg-background/95 py-2 pl-9 pr-3 text-xs text-foreground shadow-sm backdrop-blur focus:border-amber focus:outline-none focus:ring-2 focus:ring-amber/20"
              dir="rtl"
            />
            {query && (
              <button
                onClick={() => { setQuery(""); setResults([]); setShowResults(false); }}
                className="absolute left-9 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
            <button
              onClick={search}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-amber/20 px-2 py-1 text-[10px] font-medium text-amber hover:bg-amber/30"
            >
              {searching ? <Loader2 className="size-3 animate-spin" /> : "جستجو"}
            </button>
          </div>
          {showResults && results.length > 0 && (
            <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur">
              {results.map((r, i) => (
                <button
                  key={i}
                  onClick={() => flyTo(r)}
                  className="flex w-full items-start gap-2 border-b border-border px-3 py-2 text-right text-[11px] last:border-0 hover:bg-accent"
                  dir="rtl"
                >
                  <MapPin className="mt-0.5 size-3 shrink-0 text-amber" />
                  <span className="flex-1 text-foreground">{r.display_name}</span>
                </button>
              ))}
            </div>
          )}
          {showResults && !searching && results.length === 0 && (
            <div className="mt-1 rounded-lg border border-border bg-background/95 px-3 py-2 text-[11px] text-muted-foreground shadow-lg backdrop-blur">
              نتیجه‌ای یافت نشد
            </div>
          )}
        </div>
      )}

      {/* Compass */}
      <div className="absolute left-3 top-3 z-[1000] grid size-8 place-items-center rounded-lg border border-border bg-background/70 backdrop-blur">
        <span className="font-mono text-[9px] text-muted-foreground">N</span>
      </div>
    </div>
  );
}
