import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// PATCH /api/technicians/[id]/availability
// A technician may control only their own availability. Exact coordinates are
// accepted from the authenticated technician but are never exposed publicly.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  if (session.role !== "TECHNICIAN" && session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه JSON نامعتبر است" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (typeof input.availableNow !== "boolean") {
    return NextResponse.json({ error: "وضعیت availability باید مشخص باشد" }, { status: 400 });
  }

  const db = await getDbForLib();
  const tech = await db.technician.findUnique({
    where: { id },
    include: { user: { select: { id: true, role: true, status: true } } },
  });
  if (!tech) return NextResponse.json({ error: "پروفایل تعمیرکار یافت نشد" }, { status: 404 });

  if (session.role === "TECHNICIAN" && tech.userId !== session.userId) {
    return NextResponse.json({ error: "شما فقط می‌توانید وضعیت خودتان را تغییر دهید" }, { status: 403 });
  }

  const activeJobs = await db.job.count({
    where: {
      technicianId: tech.id,
      status: { in: ["REQUESTED", "ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL"] },
    },
  });
  if (activeJobs > 0) {
    return NextResponse.json(
      { error: "تا زمان تعیین تکلیف سفارش فعال، تغییر وضعیت حضور مجاز نیست", code: "ACTIVE_JOB_PRESENT" },
      { status: 409 }
    );
  }

  let data: { status: "ONLINE" | "OFFLINE"; availableNow: boolean; lat?: number | null; lng?: number | null; heading?: number | null };
  if (input.availableNow) {
    if (!tech.verified || tech.user.status !== "ACTIVE" || tech.user.role !== "TECHNICIAN") {
      return NextResponse.json(
        { error: "حساب تعمیرکار هنوز تأیید یا فعال نشده است", code: "TECHNICIAN_NOT_ELIGIBLE" },
        { status: 409 }
      );
    }
    const lat = input.lat;
    const lng = input.lng;
    if (
      typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180
    ) {
      return NextResponse.json(
        { error: "برای آنلاین شدن، دسترسی موقعیت مکانی معتبر لازم است", code: "LOCATION_REQUIRED" },
        { status: 400 }
      );
    }
    data = { status: "ONLINE", availableNow: true, lat, lng, heading: null };
  } else {
    data = { status: "OFFLINE", availableNow: false, lat: null, lng: null, heading: null };
  }

  const updated = await db.technician.updateMany({
    where: {
      id: tech.id,
      userId: tech.userId,
      status: tech.status,
      availableNow: tech.availableNow,
      verified: tech.verified,
      user: { is: { status: tech.user.status, role: tech.user.role } },
    },
    data,
  });
  if (updated.count !== 1) {
    return NextResponse.json(
      { error: "وضعیت تعمیرکار هم‌زمان تغییر کرده است؛ دوباره تلاش کنید", code: "AVAILABILITY_CONFLICT" },
      { status: 409 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: data.status,
    availableNow: data.availableNow,
  });
}
