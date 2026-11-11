import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { otpSendSchema } from "@/lib/schemas";

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
function isUniqueConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "P2002" || /unique constraint/i.test(value?.message ?? "");
}

const ALLOWED_APPLICATION_FIELDS = [
  "fullName", "phone", "email", "city", "experienceYears",
  "specialties", "certifications", "bio", "vehicleOwned",
] as const;

export async function POST(req: Request) {
  const clientId = getClientId(req);
  const rateLimit = await rateLimitAsync(
    `mechanic-application:${clientId}`,
    RATE_LIMITS.MECHANIC_APPLICATION.max,
    RATE_LIMITS.MECHANIC_APPLICATION.windowMs,
  );
  if (rateLimit.unavailable) {
    return NextResponse.json(
      { error: "سرویس ثبت درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "تعداد درخواست‌های همکاری بیش از حد مجاز است؛ بعداً دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rateLimit.resetMs / 1000)) } },
    );
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Mass-assignment protection
  const safe: Record<string, any> = {};
  for (const key of ALLOWED_APPLICATION_FIELDS) {
    if (key in body) safe[key] = body[key];
  }

  const { fullName, phone, email, city, experienceYears, specialties, certifications, bio, vehicleOwned } = safe;
  if (typeof fullName !== "string" || !fullName.trim() || typeof phone !== "string") {
    return NextResponse.json({ error: "نام و شماره تلفن الزامی است" }, { status: 400 });
  }
  const phoneValidation = otpSendSchema.safeParse({ phone });
  if (!phoneValidation.success) {
    return NextResponse.json({ error: phoneValidation.error.issues[0]?.message ?? "شماره موبایل نامعتبر است" }, { status: 400 });
  }

  // Keep the application phone identical to the OTP identity key. This avoids
  // creating a technician account with a formatted phone that login cannot match.
  const normalizedPhone = phoneValidation.data.phone.replace(/[\\s\\-()]/g, "");
  const code = `APP-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const db = await getDbForLib();

  const existingUser = await db.user.findUnique({ where: { phone: normalizedPhone } });
  if (existingUser) {
    if (existingUser.status === "SUSPENDED" ||
        (existingUser.role !== "CUSTOMER" && existingUser.role !== "TECHNICIAN")) {
      return NextResponse.json({ error: "این حساب امکان ثبت درخواست همکاری ندارد" }, { status: 409 });
    }
    const existingTech = await db.technician.findUnique({ where: { userId: existingUser.id } });
    if (existingTech) {
      return NextResponse.json({ error: "شما قبلاً به عنوان مکانیک ثبت‌شده‌اید" }, { status: 409 });
    }
  }

  // Find an existing application by its account link first, then by phone for
  // anonymous submissions. Never reset an in-progress or approved review back
  // to PENDING; that would invalidate the admin's atomic review claim.
  const existingApplication = existingUser
    ? await db.mechanicApplication.findUnique({ where: { userId: existingUser.id } })
      ?? await db.mechanicApplication.findFirst({ where: { phone: normalizedPhone }, orderBy: { createdAt: "desc" } })
    : await db.mechanicApplication.findFirst({ where: { phone: normalizedPhone }, orderBy: { createdAt: "desc" } });

  const applicationData = {
    fullName: fullName.slice(0, 200).trim(),
    phone: normalizedPhone,
    email: typeof email === "string" ? email.slice(0, 200).trim() : null,
    city: typeof city === "string" ? city.slice(0, 100).trim() : null,
    experienceYears: typeof experienceYears === "number" ? Math.max(0, Math.floor(experienceYears)) : 0,
    specialties: JSON.stringify(Array.isArray(specialties) ? specialties.slice(0, 20) : []),
    certifications: certifications ? JSON.stringify(certifications).slice(0, 5000) : null,
    bio: typeof bio === "string" ? bio.slice(0, 1000).trim() : null,
    vehicleOwned: Boolean(vehicleOwned),
  };

  if (existingApplication) {
    if (existingApplication.status !== "REJECTED" && existingApplication.status !== "ON_HOLD") {
      return NextResponse.json(
        { error: "درخواست شما در حال بررسی است یا قبلاً تعیین تکلیف شده است", status: existingApplication.status },
        { status: 409 }
      );
    }

    const reopened = await db.mechanicApplication.updateMany({
      where: { id: existingApplication.id, status: existingApplication.status },
      data: {
        ...applicationData,
        status: "PENDING",
        adminNotes: null,
        reviewerId: null,
        reviewedAt: null,
      },
    });
    if (reopened.count !== 1) {
      return NextResponse.json({ error: "وضعیت درخواست هم‌زمان تغییر کرده است؛ دوباره تلاش کنید" }, { status: 409 });
    }
    const updated = await db.mechanicApplication.findUnique({ where: { id: existingApplication.id } });
    return NextResponse.json({ ...updated, pendingReview: true });
  }

  let created;
  try {
    created = await db.mechanicApplication.create({
      data: {
        code,
        ...applicationData,
        status: "PENDING",
        userId: existingUser?.id ?? null,
      },
    });
  } catch (error) {
    // The database unique index is the final arbiter for simultaneous public
    // submissions using the same phone. Return a conflict, never a 500.
    if (!isUniqueConflict(error)) throw error;
    const concurrentApplication = await db.mechanicApplication.findFirst({
      where: { phone: normalizedPhone },
      orderBy: { createdAt: "desc" },
    });
    if (!concurrentApplication) throw error;
    return NextResponse.json(
      { error: "برای این شماره تلفن درخواست همکاری ثبت شده است", status: concurrentApplication.status },
      { status: 409 },
    );
  }

  // A technician account/profile is never created by public submission.
  return NextResponse.json({ ...created, pendingReview: true });
}
