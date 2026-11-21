// MEKANIX Phase 6 — Unit tests for the dispatch engine (@/lib/dispatch)
//
// The pure helpers (haversineKm, normalize, estimateEta) are NOT exported from
// the module — they are internal. We test them indirectly by:
//   1. Mocking @/lib/db so findBestTechnicians returns a deterministic candidate
//      set built from known inputs (coordinates, ratings, response times, skills).
//   2. Computing the *expected* distance / ETA / score in the test itself using
//      the same formulas documented in ARCHITECTURE.md §10, then asserting the
//      engine produced those values. This is a "shadow implementation" test:
//      if the source formula changes without an ARCHITECTURE update, this test
//      breaks loudly.
//
// Score formula:  score = dist*0.4 + skill*0.3 + rating*0.2 + speed*0.1
// All inputs normalized to 0..1 before weighting.
//
// Reference points (used across multiple tests):
//   Pickup at Tehran center (35.6892, 51.3890)
//   Tech A 5km north (35.7333, 51.3890)  → ~4.93 km
//   Tech B 10km east (35.6892, 51.5060)  → ~9.71 km
//   Tech C far away (35.6892, 52.0000)   → ~54.5 km — outside the 50km radius
import { describe, it, expect, vi, beforeEach } from "vitest";
import { findBestTechnicians, type DispatchCandidate } from "@/lib/dispatch";

// ──────────── Reference implementation (shadow) ────────────
// These functions mirror the source in src/lib/dispatch.ts. If the source
// changes, these tests break — which is the whole point of a shadow test.

function shadowHaversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shadowNormalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function shadowEstimateEta(distanceKm: number): number {
  return Math.ceil((distanceKm / 40) * 60);
}

// ──────────── Mock db ────────────
// The mock returns a controlled list of technicians so findBestTechnicians
// exercises the haversine / normalize / estimateEta / score / sort logic.
// We reset the mock return value between tests via `mockReturnValue`.

const mockTechnicians = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    technician: {
      findMany: (...args: any[]) => mockTechnicians(...args),
    },
    dispatchCandidate: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

// Pickup location: Tehran center
const PICKUP = { lat: 35.6892, lng: 51.3890 };

// A technician record shape matching what Prisma returns from the findMany
// in dispatch.ts (user, specialties, plus technician fields).
function mkTech(overrides: Partial<any> = {}): any {
  return {
    id: "tech_1",
    availableNow: true,
    status: "ONLINE",
    lat: PICKUP.lat,
    lng: PICKUP.lng,
    rating: 4.5,
    responseMins: 30,
    level: "BASIC",
    user: { id: "u_1", name: "Test Tech" },
    specialties: [{ category: "engine" }],
    ...overrides,
  };
}

describe("dispatch — haversineKm produces correct distances", () => {
  beforeEach(() => mockTechnicians.mockReset());

  it("matches the reference implementation for a 5km northward offset", async () => {
    const techLat = 35.7333; // ~5km north of Tehran center
    const techLng = PICKUP.lng;
    const expected = shadowHaversineKm(PICKUP.lat, PICKUP.lng, techLat, techLng);

    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_a", lat: techLat, lng: techLng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result).toHaveLength(1);
    // Engine rounds distance to 1 decimal place
    expect(result[0].distance).toBeCloseTo(expected, 1);
  });

  it("matches the reference implementation for a ~10km eastward offset", async () => {
    const techLng = 51.5060; // ~10km east
    const expected = shadowHaversineKm(PICKUP.lat, PICKUP.lng, PICKUP.lat, techLng);

    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_b", lng: techLng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result[0].distance).toBeCloseTo(expected, 1);
  });

  it("excludes technicians more than 50km away (radius filter)", async () => {
    // 52.0 longitude ~ 54km east — should be filtered out
    const farLng = 52.0000;
    const distance = shadowHaversineKm(PICKUP.lat, PICKUP.lng, PICKUP.lat, farLng);
    expect(distance).toBeGreaterThan(50);

    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_far", lng: farLng }),
      mkTech({ id: "tech_near", lng: PICKUP.lng }), // 0km away
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].technicianId).toBe("tech_near");
  });

  it("same-coordinate distance is 0 (no division by zero in atan2)", async () => {
    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_same", lat: PICKUP.lat, lng: PICKUP.lng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result[0].distance).toBe(0);
  });
});

describe("dispatch — estimateEta returns reasonable minutes", () => {
  beforeEach(() => mockTechnicians.mockReset());

  it("ETA for 0km is 0 minutes (Math.ceil(0) === 0)", async () => {
    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_0", lat: PICKUP.lat, lng: PICKUP.lng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result[0].etaMins).toBe(shadowEstimateEta(0));
    expect(result[0].etaMins).toBe(0);
  });

  it("ETA for ~10km is ~15 minutes (40km/h → 10km takes 15min)", async () => {
    const techLng = 51.5060;
    const distance = shadowHaversineKm(PICKUP.lat, PICKUP.lng, PICKUP.lat, techLng);

    mockTechnicians.mockResolvedValue([
      mkTech({ id: "tech_10", lng: techLng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    // 40 km/h → 10km takes 15min
    const expectedEta = shadowEstimateEta(distance);
    expect(result[0].etaMins).toBe(expectedEta);
    // Sanity bound: somewhere in 14..17 minutes for ~9.7km
    expect(result[0].etaMins).toBeGreaterThan(10);
    expect(result[0].etaMins).toBeLessThan(20);
  });

  it("ETA scales linearly with distance (40km fixed average speed)", async () => {
    const distances = [5, 10, 20, 30]; // km
    for (const d of distances) {
      // Pick a lng offset that produces ~d km east
      const dLng = (d / 111.32); // ~1 deg lng at equator ≈ 111.32km (close enough for the test)
      const techLng = PICKUP.lng + dLng;
      const distance = shadowHaversineKm(PICKUP.lat, PICKUP.lng, PICKUP.lat, techLng);
      mockTechnicians.mockResolvedValueOnce([
        mkTech({ id: `tech_${d}`, lng: techLng }),
      ]);

      const result = await findBestTechnicians({
        lat: PICKUP.lat,
        lng: PICKUP.lng,
        requiredSkills: [],
      });

      const expectedEta = shadowEstimateEta(distance);
      expect(result[0].etaMins).toBe(expectedEta);
    }
  });
});

describe("dispatch — normalize clamps to 0..1", () => {
  beforeEach(() => mockTechnicians.mockReset());

  it("all engine scores are within [0, 1]", async () => {
    // Extreme inputs: very far, very low rating, very slow response, zero skills
    mockTechnicians.mockResolvedValue([
      mkTech({ id: "extreme", lat: PICKUP.lat + 0.4, lng: PICKUP.lng, rating: 0, responseMins: 60 }),
      mkTech({ id: "perfect", lat: PICKUP.lat, lng: PICKUP.lng, rating: 5, responseMins: 5 }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: ["engine", "brakes", "diagnostic", "electrical", "ac"],
    });

    for (const c of result) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });

  it("normalize(0, 0, 50) = 0; normalize(50, 0, 50) = 1 (boundary)", () => {
    expect(shadowNormalize(0, 0, 50)).toBe(0);
    expect(shadowNormalize(50, 0, 50)).toBe(1);
    expect(shadowNormalize(25, 0, 50)).toBe(0.5);
  });

  it("normalize clamps negatives to 0 and values > max to 1", () => {
    expect(shadowNormalize(-10, 0, 50)).toBe(0);
    expect(shadowNormalize(100, 0, 50)).toBe(1);
  });

  it("normalize returns 0.5 when min === max (degenerate range)", () => {
    expect(shadowNormalize(7, 7, 7)).toBe(0.5);
  });
});

describe("dispatch — findBestTechnicians sorts by score desc and respects limit", () => {
  beforeEach(() => mockTechnicians.mockReset());

  it("returns candidates sorted by score descending", async () => {
    // tech_close: very close (high distScore) + full skill match + max rating
    // tech_mid:   medium distance, partial skill match, mid rating
    // tech_far:   30km away, no skill match, low rating
    mockTechnicians.mockResolvedValue([
      mkTech({
        id: "tech_far",
        lat: PICKUP.lat + 0.27, // ~30km north
        lng: PICKUP.lng,
        rating: 2,
        responseMins: 50,
        specialties: [{ category: "tyres" }],
      }),
      mkTech({
        id: "tech_close",
        lat: PICKUP.lat + 0.005, // ~0.5km north
        lng: PICKUP.lng,
        rating: 5,
        responseMins: 8,
        specialties: [{ category: "engine" }],
      }),
      mkTech({
        id: "tech_mid",
        lat: PICKUP.lat + 0.05, // ~5km north
        lng: PICKUP.lng,
        rating: 4,
        responseMins: 20,
        specialties: [{ category: "engine" }, { category: "brakes" }],
      }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: ["engine"],
    });

    expect(result).toHaveLength(3);
    // Sorted descending — first candidate has the highest score
    expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
    expect(result[1].score).toBeGreaterThanOrEqual(result[2].score);

    // tech_close should be #1 (closest + perfect skill + best rating + fastest response)
    expect(result[0].technicianId).toBe("tech_close");
    // tech_far should be #3 (30km, no skill match, low rating, slow)
    expect(result[2].technicianId).toBe("tech_far");
  });

  it("respects the limit parameter (default 5)", async () => {
    // Build 10 technicians all near the pickup — the limit should cap to 5
    const techs = Array.from({ length: 10 }, (_, i) =>
      mkTech({
        id: `tech_${i}`,
        lat: PICKUP.lat + (i * 0.001), // small increasing offsets
        lng: PICKUP.lng,
        rating: 5 - (i * 0.1),
      })
    );
    mockTechnicians.mockResolvedValue(techs);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result).toHaveLength(5);
  });

  it("respects a custom limit", async () => {
    const techs = Array.from({ length: 8 }, (_, i) =>
      mkTech({ id: `tech_${i}`, lat: PICKUP.lat, lng: PICKUP.lng, rating: 5 })
    );
    mockTechnicians.mockResolvedValue(techs);

    const result = await findBestTechnicians(
      { lat: PICKUP.lat, lng: PICKUP.lng, requiredSkills: [] },
      3
    );

    expect(result).toHaveLength(3);
  });

  it("returns an empty array when no technicians are available", async () => {
    mockTechnicians.mockResolvedValue([]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: ["engine"],
    });

    expect(result).toEqual([]);
  });

  it("returns an empty array when all technicians are out of radius", async () => {
    mockTechnicians.mockResolvedValue([
      mkTech({ id: "far_1", lat: PICKUP.lat + 0.5, lng: PICKUP.lng }), // ~55km
      mkTech({ id: "far_2", lat: PICKUP.lat - 0.5, lng: PICKUP.lng }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: [],
    });

    expect(result).toEqual([]);
  });

  it("skill matching counts matched vs total required skills", async () => {
    mockTechnicians.mockResolvedValue([
      mkTech({
        id: "tech_partial",
        lat: PICKUP.lat,
        lng: PICKUP.lng,
        specialties: [{ category: "engine" }],
      }),
    ]);

    const result = await findBestTechnicians({
      lat: PICKUP.lat,
      lng: PICKUP.lng,
      requiredSkills: ["engine", "brakes", "electrical"],
    });

    expect(result).toHaveLength(1);
    expect(result[0].skillsMatched).toBe(1);
    expect(result[0].skillsTotal).toBe(3);
  });
});
