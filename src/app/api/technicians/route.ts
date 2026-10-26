import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";

const techInclude = {
  specialties: true,
  certifications: true,
  serviceAreas: true,
} as const;

// Public-facing technician fields — never expose password or sensitive PII.
// SEC-22 fix (Agent 1 coordinator, FIX-SEC-22): `phone` removed from the
// PUBLIC list. The detail route (/api/technicians/[id]) already omitted phone
// (M-03); the list route must match — a public, unauthenticated listing must
// not leak technician phone numbers. Customers contact technicians through the
// platform (chat / job dispatch), never via direct phone.
const PUBLIC_USER_FIELDS = {
  id: true,
  name: true,
  avatar: true,
  role: true,
  status: true,
  country: true,
  currency: true,
  language: true,
  createdAt: true,
} as const;

// GET /api/technicians — public listing (no auth required).
// Selects only safe fields (no password, no sensitive data).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  const category = url.searchParams.get("category");

  const where: any = { availableNow: true, verified: true };
  if (category) {
    where.specialties = { some: { category } };
  }

  let techs = await (await getDbForLib()).technician.findMany({
    where,
    include: {
      user: { select: PUBLIC_USER_FIELDS },
      ...techInclude,
    },
  });

  // distance sort + arrival estimate
  if (lat && lng) {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    const R = 6371;
    const dist = (t: { lat: number | null; lng: number | null }) => {
      if (t.lat == null || t.lng == null) return 9999;
      const dLat = ((la - t.lat) * Math.PI) / 180;
      const dLng = ((ln - t.lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((la * Math.PI) / 180) *
          Math.cos((t.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    techs = techs
      .map((t) => ({ ...t, _dist: dist(t) }))
      .sort((a, b) => (a._dist as number) - (b._dist as number));
  }

  return NextResponse.json(techs);
}

// POST: create technician profile — ADMIN ONLY
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;

  const body = await req.json();
  const { userId, specialties = [], certifications = [], serviceAreas = [], ...rest } = body;

  // Strip forbidden fields
  const ALLOWED_TECH_FIELDS = ["bio", "experienceYears", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "availableNow", "responseMins", "lat", "lng", "heading"];
  const safeData: Record<string, any> = {};
  for (const k of ALLOWED_TECH_FIELDS) {
    if (k in rest) safeData[k] = rest[k];
  }

  const db = await getDbForLib();
  const tech = await db.technician.create({
    data: {
      userId,
      ...safeData,
      specialties: { create: specialties },
      certifications: { create: certifications },
      serviceAreas: { create: serviceAreas },
    },
    include: {
      user: { select: PUBLIC_USER_FIELDS },
      ...techInclude,
    },
  });
  return NextResponse.json(tech);
}
