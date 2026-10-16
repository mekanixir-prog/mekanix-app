// Dispatch Engine — selects the best technician for a service request.
//
// Score formula (per ARCHITECTURE.md §10):
//   score = (distance * 0.4) + (skill * 0.3) + (rating * 0.2) + (speed * 0.1)
//
// All inputs are normalized to 0..1 before weighting.
//
// Schema mapping notes:
//   - The Prisma `DispatchCandidate` model stores ETA in `eta` (Int?, minutes)
//     and rank in `finalRank` (Int?). The public DispatchCandidate interface
//     exposes them as `etaMins` / `rank` for caller ergonomics — the mapping
//     happens inside `autoAssignTechnician()` when persisting.

import { getDbForLib } from "./db-access";

export interface DispatchInput {
  lat: number;
  lng: number;
  requiredSkills: string[]; // e.g. ["engine", "diagnostic"]
  vehicleType?: string; // "CAR" | "TRUCK" | etc.
}

export interface DispatchCandidate {
  technicianId: string;
  userId: string;
  name: string;
  score: number;
  distance: number; // km
  etaMins: number;
  skillsMatched: number;
  skillsTotal: number;
  rating: number;
  level: string;
  available: boolean;
}

// ──────────── Geospatial helpers ────────────

// Haversine distance (km)
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

// Normalize a value to 0..1 given a min and max
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

// ──────────── Pluggable ETA provider ────────────
//
// ETA calculation is intentionally pluggable so production deployments can
// swap in a real routing provider (Google Maps, Mapbox, OSRM, etc.) without
// touching the scoring logic. See ARCHITECTURE.md §10.
//
// Contract: takes the pickup + technician coordinates and returns estimated
// travel time in MINUTES.

export type EtaProvider = (lat1: number, lng1: number, lat2: number, lng2: number) => number | Promise<number>;

// Default: simple 40 km/h estimate (matches the legacy `estimateEta(distanceKm)`).
// Good enough for the v1 demo; replace via `setEtaProvider()` for production.
const defaultEtaProvider: EtaProvider = (lat1, lng1, lat2, lng2) => {
  const distance = haversineKm(lat1, lng1, lat2, lng2);
  return Math.ceil((distance / 40) * 60);
};

// Current provider (can be swapped at runtime via `setEtaProvider()`).
let currentEtaProvider: EtaProvider = defaultEtaProvider;

/**
 * Replace the ETA provider at runtime.
 *
 * Example — wire in a Google Maps Distance Matrix client:
 *
 *   setEtaProvider(async (lat1, lng1, lat2, lng2) => {
 *     const r = await googleMaps.distanceMatrix({ origins: [...], destinations: [...] });
 *     return Math.ceil(r.duration / 60);
 *   });
 *
 * NOTE: the provider signature is currently synchronous to keep the dispatch
 * loop non-async per-candidate. If you wire in an async provider, refactor
 * `findBestTechnicians` to await each call.
 */
export function setEtaProvider(provider: EtaProvider): void {
  currentEtaProvider = provider;
}

/** Reset to the built-in default provider (useful for tests). */
export function resetEtaProvider(): void {
  currentEtaProvider = defaultEtaProvider;
}

/** Read-only accessor for the current provider (used by tests + introspection). */
export function getEtaProvider(): EtaProvider {
  return currentEtaProvider;
}

// ──────────── Pre-fetch pool size ────────────
//
// The dispatch engine fetches a pool of ONLINE + availableNow technicians and
// then filters in-memory by Haversine distance (the SQLite backend doesn't
// support native geospatial queries). The pool size is configurable via env
// so production can tune it without a code change.
//
//   DISPATCH_POOL_SIZE=200 (default)
//
// The previous default was 50 — too small for dense urban deployments.
const DISPATCH_POOL_SIZE = Number(process.env.DISPATCH_POOL_SIZE ?? 200);

// Search radius (km). Technicians farther than this are skipped before scoring.
const DISPATCH_RADIUS_KM = 50;

// Rank technicians for a dispatch request
export async function findBestTechnicians(input: DispatchInput, limit = 5): Promise<DispatchCandidate[]> {
  const db = await getDbForLib();
  // Fetch available technicians with their specialties.
  //
  // NOTE: Prisma + SQLite doesn't support native geospatial filtering
  // (no `ST_DWithin`, no `distance()` function). For PostGIS-backed deployments
  // a future version of this query should add:
  //
  //   where: {
  //     availableNow: true,
  //     status: "ONLINE",
  //     // ... AND ST_DWithin(location, ST_MakePoint(input.lng, input.lat)::geography, 50000)
  //   }
  //
  // Until then we fetch a configurable pool (default 200) and filter in-memory
  // by Haversine below. This is O(pool) per dispatch request and fine for the
  // expected fleet size (<10k technicians).
  const technicians = await db.technician.findMany({
    where: { availableNow: true, status: "ONLINE" },
    include: {
      user: { select: { id: true, name: true } },
      specialties: true,
    },
    take: DISPATCH_POOL_SIZE, // pre-filter pool — increased from 50 to 200 (configurable via env)
  });

  const candidates: DispatchCandidate[] = [];

  for (const tech of technicians) {
    const techLat = tech.lat ?? input.lat;
    const techLng = tech.lng ?? input.lng;
    const distance = haversineKm(input.lat, input.lng, techLat, techLng);

    // In-memory geospatial filter — skip if outside the search radius.
    if (distance > DISPATCH_RADIUS_KM) continue;

    // Skill matching
    const techSkills = tech.specialties.map((s) => s.category);
    const skillsMatched = input.requiredSkills.filter((s) => techSkills.includes(s)).length;
    const skillsTotal = input.requiredSkills.length;
    const skillRatio = skillsTotal > 0 ? skillsMatched / skillsTotal : 0.5;

    // Normalize metrics
    const distScore = 1 - normalize(distance, 0, DISPATCH_RADIUS_KM); // closer = higher score
    const ratingScore = normalize(Number(tech.rating ?? 0), 0, 5);
    const speedScore = normalize(tech.responseMins ?? 30, 5, 60);
    const speedNormalized = 1 - speedScore; // faster response = higher score

    // Weighted score per ARCHITECTURE.md §10
    const score = distScore * 0.4 + skillRatio * 0.3 + ratingScore * 0.2 + speedNormalized * 0.1;

    candidates.push({
      technicianId: tech.id,
      userId: tech.user.id,
      name: tech.user.name ?? "Unknown",
      score: Math.round(score * 100) / 100,
      distance: Math.round(distance * 10) / 10,
      etaMins: await Promise.resolve(currentEtaProvider(input.lat, input.lng, techLat, techLng)),
      skillsMatched,
      skillsTotal,
      rating: Number(tech.rating ?? 0),
      level: tech.level,
      available: tech.availableNow,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

// Auto-assign: pick the top candidate and persist all ranked candidates for audit.
//
// Schema mapping (DispatchCandidate Prisma model):
//   - `etaMins`  → `eta`       (Int?, minutes)
//   - `rank`     → `finalRank` (Int?)
export async function autoAssignTechnician(jobId: string, input: DispatchInput): Promise<DispatchCandidate | null> {
  const db = await getDbForLib();
  const candidates = await findBestTechnicians(input, 5);
  if (candidates.length === 0) return null;

  const best = candidates[0];

  // Store all candidates in DB for audit
  await db.dispatchCandidate.createMany({
    data: candidates.map((c, idx) => ({
      bookingId: jobId,
      technicianId: c.technicianId,
      score: c.score,
      distance: c.distance,
      eta: c.etaMins,
      finalRank: idx + 1,
    })),
  });

  return best;
}
