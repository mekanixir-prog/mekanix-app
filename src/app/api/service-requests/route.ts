import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { IdempotencyConflictError, readIdempotencyKey, requestFingerprint } from "@/lib/idempotency";
import { createServiceRequestAtomically } from "@/lib/service-request-atomic";
import { getCustomerFromSession, getTechnicianFromSession } from "@/lib/auth";

const include = {
  customer: { include: { user: true } },
  vehicle: true,
  matchedTech: { include: { user: true } },
  job: {
    include: {
      technician: { include: { user: true } },
      invoice: true,
      reviews: true,
    },
  },
} as const;

// GET /api/service-requests
// BOLA-protected: customer sees their own requests, technician sees assigned matches, admin sees all.
// Client-supplied customerId/technicianId query params are IGNORED.
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
  // ADMIN sees all

  const db = await getDbForLib();
  const list = await db.serviceRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include,
  });
  return NextResponse.json(list);
}

// POST /api/service-requests
// - customerId is derived from session — NEVER from request body (BOLA / mass-assignment).
// - If no vehicleId provided, creates an ad-hoc vehicle owned by the session's customer.
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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Resolve the customer from the session
  let customerId: string;
  if (session.role === "ADMIN") {
    // Admin may specify a customer on behalf
    if (typeof body.customerId !== "string" || !body.customerId) {
      return NextResponse.json({ error: "customerId الزامی است" }, { status: 400 });
    }
    customerId = body.customerId;
  } else {
    const customer = await getCustomerFromSession(session);
    if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
    customerId = customer.id;
  }

  // Validate required fields
  if (typeof body.category !== "string" || !body.category.trim()) {
    return NextResponse.json({ error: "category الزامی است" }, { status: 400 });
  }
  if (typeof body.title !== "string" || body.title.trim().length < 3) {
    return NextResponse.json({ error: "title الزامی است (حداقل ۳ نویسه)" }, { status: 400 });
  }
  if (typeof body.address !== "string" || !body.address.trim()) {
    return NextResponse.json({ error: "address الزامی است" }, { status: 400 });
  }
  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json({ error: "موقعیت جغرافیایی الزامی است" }, { status: 400 });
  }

  // If a vehicleId is provided, ensure it belongs to this customer (BOLA)
  let vehicleId = typeof body.vehicleId === "string" ? body.vehicleId : undefined;
  const db = await getDbForLib();
  if (vehicleId) {
    const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { customerId: true } });
    if (!vehicle || vehicle.customerId !== customerId) {
      return NextResponse.json({ error: "خودرو متعلق به این مشتری نیست" }, { status: 403 });
    }
  } else {
    // Create an ad-hoc vehicle owned by this customer
    const adHocVehicle = await db.vehicle.create({
      data: {
        customerId,
        type: typeof body.machineType === "string" ? body.machineType : "CAR",
        make: typeof body.make === "string" ? body.make.slice(0, 100) : "Unspecified",
        model: typeof body.model === "string" ? body.model.slice(0, 100) : "Ad-hoc",
        year: new Date().getFullYear(),
        plate: null,
        location: typeof body.address === "string" ? body.address.slice(0, 200) : null,
        lat: body.lat,
        lng: body.lng,
        notes: "Created at request time",
      },
    });
    vehicleId = adHocVehicle.id;
  }

  const code = `SR-${Math.floor(2000 + Math.random() * 8000)}`;

  const sr = await db.serviceRequest.create({
    data: {
      code,
      customerId, // server-authoritative
      vehicleId,
      category: body.category.slice(0, 50),
      urgency: ["NORMAL", "URGENT", "EMERGENCY"].includes(body.urgency) ? body.urgency : "NORMAL",
      title: body.title.slice(0, 200),
      description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
      mediaUrls: JSON.stringify(Array.isArray(body.mediaUrls) ? body.mediaUrls.slice(0, 12) : []),
      voiceNote: typeof body.voiceNote === "string" ? body.voiceNote.slice(0, 500) : null,
      address: body.address.slice(0, 300),
      lat: body.lat,
      lng: body.lng,
      status: "OPEN",
    },
    include,
  });

  // Notify matching technicians (demo: first 3 online+verified in category)
  const techs = await db.technician.findMany({
    where: {
      availableNow: true,
      verified: true,
      ...(body.category ? { specialties: { some: { category: body.category } } } : {}),
    },
    take: 3,
  });
  for (const t of techs) {
    await db.notification.create({
      data: {
        userId: t.userId,
        type: "new_request",
        title: "New job match nearby",
        body: `${sr.code} — ${sr.title}`,
        category: "job",
        link: "technician/requests",
      },
    });
  }
  // Admin notification
  const admin = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (admin) {
    await db.notification.create({
      data: {
        userId: admin.id,
        type: "new_request",
        title: "New service request",
        body: `${sr.code} — ${sr.title}`,
        category: "job",
        link: "admin/jobs",
      },
    });
  }

  return NextResponse.json(sr);
}
// POST /api/service-requests
// The request and an optional ad-hoc vehicle are committed atomically. Notifications
// are post-commit best-effort side effects and never change the request result.
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
  if (vehicleId) {
    const vehicle = await db.vehicle.findUnique({
      where: { id: vehicleId },
      select: { customerId: true },
    });
    if (!vehicle || vehicle.customerId !== customerId) {
      return NextResponse.json({ error: "خودرو متعلق به این مشتری نیست" }, { status: 403 });
    }
  }

  const urgency = (["NORMAL", "URGENT", "EMERGENCY"] as const).includes(body.urgency)
    ? body.urgency
    : "NORMAL";
  const normalized = {
    actorUserId: session.userId,
    customerId,
    vehicleId,
    machineType: (["CAR", "TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL", "OTHER"] as string[])
      .includes(body.machineType) ? body.machineType : "CAR",
    make: typeof body.make === "string" ? body.make.slice(0, 100) : "Unspecified",
    model: typeof body.model === "string" ? body.model.slice(0, 100) : "Ad-hoc",
    category: body.category.trim().slice(0, 50),
    urgency,
    title: body.title.trim().slice(0, 200),
    description: typeof body.description === "string" ? body.description.slice(0, 2000) : "",
    mediaUrls: JSON.stringify(Array.isArray(body.mediaUrls) ? body.mediaUrls.slice(0, 12) : []),
    voiceNote: typeof body.voiceNote === "string" ? body.voiceNote.slice(0, 500) : null,
    address: body.address.trim().slice(0, 300),
    lat: body.lat,
    lng: body.lng,
  };
  const idempotencyKey = `service-request:${session.userId}:${rawKey}`;
  const fingerprint = requestFingerprint(normalized);

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
    if (!requestRecord) {
      throw new Error("Service request committed but could not be read back");
    }

    if (result.created) {
      // Notifications are deliberately outside the atomic business write.
      try {
        const techs = await db.technician.findMany({
          where: {
            availableNow: true,
            verified: true,
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
        // A notification outage must not turn a committed request into a failed submission.
      }
    }

    return NextResponse.json(requestRecord, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: "این کلید قبلاً برای اطلاعات متفاوتی استفاده شده است" }, { status: 409 });
    }
    throw error;
  }
}
