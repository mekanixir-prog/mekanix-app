import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole, sanitizeInput, FORBIDDEN_FIELDS } from "@/lib/auth";

// GET: list mechanic applications — ADMIN only
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const db = await getDbForLib();
  const list = await db.mechanicApplication.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  return NextResponse.json(list);
}

// POST: public — anyone can apply to become a mechanic.
// Application status is PENDING — NOT auto-approved.
// Admin must review and approve before technician is activated.
const ALLOWED_APPLICATION_FIELDS = [
  "fullName", "phone", "email", "city", "experienceYears",
  "specialties", "certifications", "bio", "vehicleOwned",
] as const;

export async function POST(req: Request) {
  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Mass-assignment protection
  const safe: Record<string, any> = {};
  for (const k of ALLOWED_APPLICATION_FIELDS) {
    if (k in body) safe[k] = body[k];
  }

  const { fullName, phone, email, city, experienceYears, specialties, certifications, bio, vehicleOwned } = safe;
  if (typeof fullName !== "string" || !fullName.trim() || typeof phone !== "string" || !phone.trim()) {
    return NextResponse.json({ error: "نام و شماره تلفن الزامی است" }, { status: 400 });
  }

  const normalizedPhone = phone.trim();
  const code = `APP-${Math.floor(1000 + Math.random() * 9000)}`;

  const db = await getDbForLib();

  // Check if user with this phone already exists
  const existingUser = await db.user.findUnique({ where: { phone: normalizedPhone } });

  // If user exists and already has a technician profile, reject duplicate
  if (existingUser) {
    const existingTech = await db.technician.findUnique({ where: { userId: existingUser.id } });
    if (existingTech) {
      return NextResponse.json({ error: "شما قبلاً به عنوان مکانیک ثبت‌شده‌اید" }, { status: 409 });
    }
  }

  // Create or update application — status is PENDING, NOT APPROVED
  const app = await db.mechanicApplication.upsert({
    where: existingUser ? { userId: existingUser.id } : { code },
    create: {
      code,
      fullName: fullName.slice(0, 200).trim(),
      phone: normalizedPhone,
      email: typeof email === "string" ? email.slice(0, 200).trim() : null,
      city: typeof city === "string" ? city.slice(0, 100).trim() : null,
      experienceYears: typeof experienceYears === "number" ? Math.max(0, Math.floor(experienceYears)) : 0,
      specialties: JSON.stringify(Array.isArray(specialties) ? specialties.slice(0, 20) : []),
      certifications: certifications ? JSON.stringify(certifications).slice(0, 5000) : null,
      bio: typeof bio === "string" ? bio.slice(0, 1000).trim() : null,
      vehicleOwned: Boolean(vehicleOwned),
      status: "PENDING", // NOT auto-approved — admin must review
      userId: existingUser?.id || null,
    },
    update: {
      fullName: fullName.slice(0, 200).trim(),
      phone: normalizedPhone,
      email: typeof email === "string" ? email.slice(0, 200).trim() : null,
      city: typeof city === "string" ? city.slice(0, 100).trim() : null,
      experienceYears: typeof experienceYears === "number" ? Math.max(0, Math.floor(experienceYears)) : 0,
      specialties: JSON.stringify(Array.isArray(specialties) ? specialties.slice(0, 20) : []),
      bio: typeof bio === "string" ? bio.slice(0, 1000).trim() : null,
      vehicleOwned: Boolean(vehicleOwned),
      status: "PENDING", // Reset to PENDING if re-applied
    },
  });

  // Do NOT create Technician or User with TECHNICIAN role — admin must approve first
  return NextResponse.json({ ...app, pendingReview: true });
}
