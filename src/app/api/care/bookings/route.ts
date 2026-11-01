import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth, validateBody } from "@/lib/api-helpers";
import { getCustomerFromSession } from "@/lib/auth";
import { careBookingSchema } from "@/lib/schemas";
import { requestFingerprint } from "@/lib/idempotency";
import { calculatePrice } from "@/lib/pricing";
import { checkVipStatus } from "@/lib/vip";
import { wantsLite, liteResponse } from "@/lib/lite-response";
import {
  CareBookingIdempotencyConflict,
  createCareBookingAtomically,
} from "@/lib/care-booking-atomic";

// POST /api/care/bookings — create a service booking.
// Idempotency-Key is mandatory. The booking, frozen pricing snapshot, link,
// and creation timeline event are committed as one unit on PostgreSQL/SQLite
// and one D1 batch on Cloudflare Workers.
export async function POST(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return NextResponse.json(
      { error: "هدر Idempotency-Key معتبر و الزامی است" },
      { status: 400 }
    );
  }

  const body = await validateBody(req, careBookingSchema);
  if (!body.ok) return body.response;

  const {
    vehicleId, packageId, serviceType, location, lat, lng,
    date, timeWindow, currentMileage,
  } = body.data;

  const customer = await getCustomerFromSession(session);
  if (!customer) {
    return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
  }

  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle || vehicle.customerId !== customer.id) {
    return NextResponse.json({ error: "خودرو متعلق به شما نیست" }, { status: 403 });
  }

  const normalized = {
    userId: session.userId,
    vehicleId,
    packageId: packageId || null,
    serviceType: serviceType || "periodic",
    location,
    lat: lat ?? null,
    lng: lng ?? null,
    date: date ? new Date(date).toISOString() : null,
    timeWindow: timeWindow || null,
    currentMileage: currentMileage ?? null,
  };
  const fingerprint = await requestFingerprint(normalized);

  // Fast replay path avoids recalculating a frozen historical price.
  const existing = await db.serviceBooking.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      return NextResponse.json(
        { error: "این کلید قبلاً برای اطلاعات متفاوتی استفاده شده است" },
        { status: 409 }
      );
    }
    return NextResponse.json(existing);
  }

  const vipStatus = await checkVipStatus(session.userId);
  const pricing = await calculatePrice({
    packageId: packageId || undefined,
    vehicleType: vehicle.type,
    laborHours: 1,
    partsCost: 0,
    travelDistanceKm: 0,
    isEmergency: serviceType === "emergency",
    vipDiscountPercent: vipStatus.active ? vipStatus.discountPercent : 0,
  });

  try {
    const booking = await createCareBookingAtomically(db, {
      idempotencyKey,
      requestFingerprint: fingerprint,
      code: `CARE-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      ...normalized,
      date: date ? new Date(date) : null,
      pricing,
    });
    return NextResponse.json(booking);
  } catch (error) {
    if (error instanceof CareBookingIdempotencyConflict) {
      return NextResponse.json(
        { error: "این کلید قبلاً برای اطلاعات متفاوتی استفاده شده است" },
        { status: 409 }
      );
    }
    throw error;
  }
}

// GET /api/care/bookings — list user's bookings
export async function GET(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const bookings = await db.serviceBooking.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    include: {
      package: true,
      timeline: { orderBy: { timestamp: "asc" } },
    },
  });

  const lite = wantsLite(req);
  return NextResponse.json(liteResponse(bookings, lite));
}
