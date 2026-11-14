import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";
import { PUBLIC_TECHNICIAN_SELECT, toPublicTechnician } from "@/lib/public-technician";

// Public-facing technician fields — never expose password or sensitive PII.
// SEC-22 fix (Agent 1 coordinator, FIX-SEC-22): `phone` removed from the
// PUBLIC list. The detail route (/api/technicians/[id]) already omitted phone
// (M-03); the list route must match — a public, unauthenticated listing must
// not leak technician phone numbers. Customers contact technicians through the
// platform (chat / job dispatch), never via direct phone.
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

  const techs = await (await getDbForLib()).technician.findMany({
    where,
    select: { ...PUBLIC_TECHNICIAN_SELECT, lat: true, lng: true },
  });

  // Coordinates are used only to calculate an approximate distance for sorting.
  // They are never included in the public response.
  const distanceById = new Map<string, number>();
  const hasCoordinates = lat !== null || lng !== null;
  if (hasCoordinates) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
      return NextResponse.json({ error: "مختصات جغرافیایی نامعتبر است" }, { status: 400 });
    }
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
    techs.sort((a, b) => dist(a) - dist(b));
    for (const tech of techs) distanceById.set(tech.id, dist(tech));
  }

  return NextResponse.json(
    techs.map((tech) => toPublicTechnician(tech, distanceById.get(tech.id)))
  );
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
