// MEKANIX — ETA Provider with env-based configuration
//
// When a routing API key is set (NESHAN_API_KEY or GOOGLE_MAPS_API_KEY),
// uses real routing for accurate ETA.
// Otherwise, falls back to the default 40 km/h estimate.
//
// Supported providers:
//   1. Neshan (Iranian routing API) — set NESHAN_API_KEY
//   2. Google Maps Distance Matrix — set GOOGLE_MAPS_API_KEY
//   3. OSRM (self-hosted, free) — set OSRM_API_URL
//   4. Default (40 km/h haversine) — no env needed

import { setEtaProvider, type EtaProvider } from "./dispatch";

// ──────────── Haversine distance (km) ────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ──────────── Default ETA (40 km/h estimate) ────────────

const defaultEtaProvider: EtaProvider = (lat1, lng1, lat2, lng2) => {
  const distance = haversineKm(lat1, lng1, lat2, lng2);
  return Math.ceil((distance / 40) * 60); // minutes
};

// ──────────── Neshan ETA provider ────────────
// Iranian routing API: https://platform.neshan.org/api/direction

function createNeshanProvider(apiKey: string): EtaProvider {
  return async (lat1, lng1, lat2, lng2) => {
    try {
      const url = `https://api.neshan.org/v4/direction?type=car&origin=${lat1},${lng1}&destination=${lat2},${lng2}`;
      const res = await fetch(url, {
        headers: { "Api-Key": apiKey },
        signal: AbortSignal.timeout(5000), // 5s timeout
      });
      if (!res.ok) throw new Error(`Neshan API: ${res.status}`);
      const data = await res.json();
      // Neshan returns duration in seconds
      const durationSec = data.routes?.[0]?.legs?.[0]?.duration?.value ?? 0;
      return Math.ceil(durationSec / 60); // seconds → minutes
    } catch {
      // Fall back to default on error
      return defaultEtaProvider(lat1, lng1, lat2, lng2);
    }
  };
}

// ──────────── Google Maps ETA provider ────────────

function createGoogleMapsProvider(apiKey: string): EtaProvider {
  return async (lat1, lng1, lat2, lng2) => {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat1},${lng1}&destinations=${lat2},${lng2}&key=${apiKey}&mode=driving`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Google Maps API: ${res.status}`);
      const data = await res.json();
      const durationSec = data.rows?.[0]?.elements?.[0]?.duration?.value ?? 0;
      return Math.ceil(durationSec / 60);
    } catch {
      return defaultEtaProvider(lat1, lng1, lat2, lng2);
    }
  };
}

// ──────────── OSRM ETA provider (self-hosted, free) ────────────

function createOsrmProvider(apiUrl: string): EtaProvider {
  return async (lat1, lng1, lat2, lng2) => {
    try {
      const url = `${apiUrl}/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`OSRM API: ${res.status}`);
      const data = await res.json();
      const durationSec = data.routes?.[0]?.duration ?? 0;
      return Math.ceil(durationSec / 60);
    } catch {
      return defaultEtaProvider(lat1, lng1, lat2, lng2);
    }
  };
}

// ──────────── Initialize ETA provider from env ────────────

let initialized = false;

export function initEtaProvider(): void {
  if (initialized) return;
  initialized = true;

  const neshanKey = process.env.NESHAN_API_KEY;
  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  const osrmUrl = process.env.OSRM_API_URL;

  if (neshanKey) {
    console.log("🗺️  ETA provider: Neshan (Iranian routing API)");
    setEtaProvider(createNeshanProvider(neshanKey));
  } else if (googleKey) {
    console.log("🗺️  ETA provider: Google Maps Distance Matrix");
    setEtaProvider(createGoogleMapsProvider(googleKey));
  } else if (osrmUrl) {
    console.log("🗺️  ETA provider: OSRM (self-hosted)");
    setEtaProvider(createOsrmProvider(osrmUrl));
  } else {
    console.log("🗺️  ETA provider: default (40 km/h estimate)");
    // default is already set in dispatch.ts
  }
}

// ──────────── Export for testing ────────────

export { defaultEtaProvider, haversineKm };
