import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getCustomerFromSession, getTechnicianFromSession } from "@/lib/auth";
import { IdempotencyConflictError, readIdempotencyKey, requestFingerprint } from "@/lib/idempotency";
import { createServiceRequestAtomically, ServiceRequestVehicleError } from "@/lib/service-request-atomic";
import { maskFinancialFields, maskJobFinancialData } from "@/lib/money/financial-read-mask";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";

const include = {
  customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
  vehicle: true,
  matchedTech: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
  job: {
    include: {
      technician: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
      invoice: true,
      reviews: true,
    },
  },
} as const;

// GET /api/service-requests
// Customer sees own requests; technicians see assigned matches; admins see all.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const where: any = {};
  if (status) where.status = status;

  if (session.role === "CUSTOMER") {
    const customer = await getCustomerFromSession(session);
    if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
    where.customerId = customer.id;
  } else if (session.role === "TECHNICIAN") {
    const tech = await getTechnicianFromSession(session);
    if (!tech) return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
    where.matchedTechId = tech.id;
  }

  const db = await getDbForLib();
  const list = await db.serviceRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include,
  });
  const safeList = list.map((request) => ({
    ...request,
    matchedTech: request.matchedTech ? maskFinancialFields(request.matchedTech, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]) : request.matchedTech,
    job: request.job ? maskJobFinancialData(request.job) : request.job,
  }));
  return NextResponse.json(safeList);
}

// POST /api/service-requests
// A customer must select a registered, in-scope vehicle before requesting service.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  if (session.role !== "CUSTOMER" && session.role !== "ADMIN") {
    return NextResponse.json({ error: "فقط مشتریان می‌توانند درخواست ثبت کنند" }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست معتبر نیست" }, { status: 400 });
  }

  const rawKey = readIdempotencyKey(req);
  if (!rawKey) {
    return NextResponse.json({ error: "هدر Idempotency-Key معتبر و الزامی است" }, { status: 400 });
  }

  let customerId: string;
  if (session.role === "ADMIN") {
    if (typeof body.customerId !== "string" || !body.customerId) {
      return NextResponse.json({ error: "customerId الزامی است" }, { status: 400 });
    }
    customerId = body.customerId;
  } else {
    const customer = await getCustomerFromSession(session);
    if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
    customerId = customer.id;
  }

  if (typeof body.category !== "string" || !body.category.trim()) {
    return NextResponse.json({ error: "category الزامی است" }, { status: 400 });
  }
  if (typeof body.title !== "string" || body.title.trim().length < 3) {
    return NextResponse.json({ error: "title الزامی است (حداقل ۳ نویسه)" }, { status: 400 });
  }
  if (typeof body.address !== "string" || !body.address.trim()) {
    return NextResponse.json({ error: "address الزامی است" }, { status: 400 });
  }
  if (
    typeof body.lat !== "number" || !Number.isFinite(body.lat) || body.lat < -90 || body.lat > 90 ||
    typeof body.lng !== "number" || !Number.isFinite(body.lng) || body.lng < -180 || body.lng > 180
  ) {
    return NextResponse.json({ error: "موقعیت جغرافیایی معتبر الزامی است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const vehicleId = typeof body.vehicleId === "string" && body.vehicleId.trim()
    ? body.vehicleId.trim()
    : null;
  if (!vehicleId) {
    return NextResponse.json({ error: "برای ثبت درخواست ابتدا باید وسیله خود را ثبت کنید", code: "VEHICLE_REGISTRATION_REQUIRED" }, { status: 400 });
  }
  const vehicle = await db.vehicle.findUnique({
    where: { id: vehicleId },
    select: { customerId: true, type: true, make: true, model: true },
  });
  if (!vehicle || vehicle.customerId !== customerId) {
    return NextResponse.json({ error: "وسیله متعلق به این مشتری نیست" }, { status: 403 });
  }
  if (!isVehicleInSupportedScope(vehicle.type, vehicle.make)) {
    return NextResponse.json({ error: "این خودروی سواری در محدوده خدمات MEKANIX نیست", code: "VEHICLE_OUT_OF_SCOPE" }, { status: 400 });
  }

  const normalized = {
    actorUserId: session.userId,
    customerId,
    vehicleId,
    category: body.category.trim().slice(0, 50),
    urgency: (["NORMAL", "URGENT", "EMERGENCY"].includes(body.urgency) ? body.urgency : "NORMAL") as "NORMAL" | "URGENT" | "EMERGENCY",
    title: body.title.trim().slice(0, 200),
    description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
    mediaUrls: JSON.stringify(Array.isArray(body.mediaUrls) ? body.mediaUrls.slice(0, 12) : []),
    voiceNote: typeof body.voiceNote === "string" ? body.voiceNote.slice(0, 500) : null,
    address: body.address.trim().slice(0, 300),
    lat: body.lat,
    lng: body.lng,
  };

  const idempotencyKey = `service-request:${session.userId}:${rawKey}`;
  const fingerprint = await requestFingerprint(normalized);

  try {
    const result = await createServiceRequestAtomically(db, {
      ...normalized,
      idempotencyKey,
      requestFingerprint: fingerprint,
      code: `SR-${crypto.randomUUID().toUpperCase()}`,
    });
    const requestRecord = await db.serviceRequest.findUnique({
      where: { idempotencyKey },
      include,
    });
    if (!requestRecord) throw new Error("Service request committed but could not be read back");

    if (result.created) {
      try {
        const techs = await db.technician.findMany({
          where: {
            availableNow: true,
            verified: true,
            status: "ONLINE",
            user: { is: { status: "ACTIVE", role: "TECHNICIAN" } },
            specialties: { some: { category: normalized.category } },
          },
          take: 3,
          select: { userId: true },
        });
        const admin = await db.user.findFirst({
          where: { role: "ADMIN" },
          select: { id: true },
        });
        const notifications = [
          ...techs.map((tech) => db.notification.create({
            data: {
              userId: tech.userId,
              type: "new_request",
              title: "New job match nearby",
              body: `${requestRecord.code} — ${requestRecord.title}`,
              category: "job",
              link: "technician/requests",
            },
          })),
          ...(admin ? [db.notification.create({
            data: {
              userId: admin.id,
              type: "new_request",
              title: "New service request",
              body: `${requestRecord.code} — ${requestRecord.title}`,
              category: "job",
              link: "admin/jobs",
            },
          })] : []),
        ];
        await Promise.allSettled(notifications);
      } catch {
        // A notification outage must not make a committed request appear failed.
      }
    }

    const safeRequestRecord = {
      ...requestRecord,
      matchedTech: requestRecord.matchedTech ? maskFinancialFields(requestRecord.matchedTech, ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"]) : requestRecord.matchedTech,
      job: requestRecord.job ? maskJobFinancialData(requestRecord.job) : requestRecord.job,
    };
    return NextResponse.json(safeRequestRecord, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ServiceRequestVehicleError) {
      return NextResponse.json({ error: "وسیله ثبت‌شده دیگر در دسترس این مشتری نیست", code: "VEHICLE_NOT_AVAILABLE" }, { status: 409 });
    }
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: "این کلید قبلاً برای اطلاعات متفاوتی استفاده شده است" }, { status: 409 });
    }
    throw error;
  }
}
