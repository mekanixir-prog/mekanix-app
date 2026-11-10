import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";

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

  const where: any = {
    availableNow: true,
    verified: true,
    status: "ONLINE",
    user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
  };
  if (category) where.specialties = { some: { category } };

  // Validate request coordinates and calculate distance server-side. Exact
  // technician coordinates and service-area pins are never sent to the client.
  let customerPoint: { lat: number; lng: number } | null = null;
  if (lat !== null || lng !== null) {
    const parsedLat = lat === null ? NaN : Number(lat);
    const parsedLng = lng === null ? NaN : Number(lng);
    if (
      !Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90 ||
      !Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180
    ) {
      return NextResponse.json({ error: "موقعیت جغرافیایی نامعتبر است" }, { status: 400 });
    }
    customerPoint = { lat: parsedLat, lng: parsedLng };
  }

  const techs = await (await getDbForLib()).technician.findMany({
    where,
    include: {
      user: { select: PUBLIC_USER_FIELDS },
      ...techInclude,
    },
  });

  const calculateDistance = (tech: { lat: number | null; lng: number | null }): number | null => {
    if (!customerPoint || tech.lat === null || tech.lng === null) return null;
    const R = 6371;
    const dLat = ((customerPoint.lat - tech.lat) * Math.PI) / 180;
    const dLng = ((customerPoint.lng - tech.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((customerPoint.lat * Math.PI) / 180) *
        Math.cos((tech.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
  };

  const safeTechs = techs
    .map((tech) => ({ tech, distanceKm: calculateDistance(tech) }))
    .sort((a, b) => {
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    })
    .map(({ tech, distanceKm }) => {
      const { lat: _lat, lng: _lng, serviceAreas, ...safeTech } = tech;
      return maskFinancialFields({
        ...safeTech,
        lat: null,
        lng: null,
        serviceAreas: serviceAreas.map(({ name, radiusKm }) => ({ name, radiusKm })),
        distanceKm,
      }, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]);
    });

  return NextResponse.json(safeTechs);
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
  return NextResponse.json(maskFinancialFields(tech, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]));
}
