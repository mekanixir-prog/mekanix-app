import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { sanitizeInput, ALLOWED_FIELDS, FORBIDDEN_FIELDS } from "@/lib/auth";

// Public-facing technician fields — never expose sensitive data.
const PUBLIC_USER_FIELDS = {
  id: true,
  name: true,
  phone: true,
  avatar: true,
  role: true,
  status: true,
  country: true,
  currency: true,
  language: true,
  createdAt: true,
} as const;

// GET /api/technicians/[id] — public profile (no auth required).
// Selects only safe fields.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDbForLib();
  const tech = await db.technician.findUnique({
    where: { id },
    include: {
      user: { select: PUBLIC_USER_FIELDS },
      specialties: true,
      certifications: true,
      serviceAreas: true,
      reviews: { include: { fromUser: { select: PUBLIC_USER_FIELDS } }, orderBy: { createdAt: "desc" }, take: 20 },
      jobsAssigned: {
        where: { status: "COMPLETED" },
        take: 8,
        orderBy: { completedAt: "desc" },
        include: { request: { include: { vehicle: true } } },
      },
    },
  });
  if (!tech) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(tech);
}

// PATCH /api/technicians/[id]
// Only the technician themselves (matching session.userId → technician.userId) or ADMIN may edit.
// Mass-assignment protection: server-authoritative fields (verified, rating, reviewCount,
// completedJobs, level, status) are BLOCKED from client updates — only admins may set them,
// and they go through /api/admin/technicians/[id].
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  // Authorization: only the owner of this technician profile (or admin)
  if (session.role !== "ADMIN") {
    if (session.role !== "TECHNICIAN") {
      return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
    }
    const tech = await (await getDbForLib()).technician.findUnique({ where: { id }, select: { userId: true } });
    if (!tech) return NextResponse.json({ error: "مکانیک یافت نشد" }, { status: 404 });
    if (tech.userId !== session.userId) {
      return NextResponse.json({ error: "شما فقط می‌توانید پروفایل خودتان را ویرایش کنید" }, { status: 403 });
    }
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Defense-in-depth: strip forbidden server-authoritative fields, even for admins using this route.
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(key)) delete body[key];
  }
  // Block changes to verified, rating, reviewCount, completedJobs, level, status — these
  // are server-computed / admin-only via /api/admin/* routes.
  const BLOCKED_FOR_SELF = ["verified", "rating", "reviewCount", "completedJobs", "level", "status"];
  if (session.role !== "ADMIN") {
    for (const k of BLOCKED_FOR_SELF) {
      delete body[k];
    }
  } else {
    // Even admins editing via this route can't change these — they must use /api/admin/technicians/[id]
    for (const k of BLOCKED_FOR_SELF) {
      delete body[k];
    }
  }

  const safe = sanitizeInput(body, ALLOWED_FIELDS.technician);
  if (Object.keys(safe).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد قابل ویرایشی ارسال نشده" }, { status: 400 });
  }

  const updated = await (await getDbForLib()).technician.update({
    where: { id },
    data: safe as any,
    include: {
      user: { select: PUBLIC_USER_FIELDS },
      specialties: true,
    },
  });
  return NextResponse.json(updated);
}
