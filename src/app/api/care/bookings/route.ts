import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth, validateBody } from "@/lib/api-helpers";
import { getCustomerFromSession } from "@/lib/auth";
import { careBookingSchema } from "@/lib/schemas";
import { requestFingerprint } from "@/lib/idempotency";
import { calculatePrice } from "@/lib/pricing";
import { wantsLite, liteResponse } from "@/lib/lite-response";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";
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
    vehicleId, packageId, serviceType, expectedPricingVersion, location, lat, lng,
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
  if (!isVehicleInSupportedScope(vehicle.type, vehicle.make)) {
    return NextResponse.json({ error: "این وسیله یا برند در محدوده خدمات و نرخ‌نامه تأییدشده MEKANIX نیست", code: "VEHICLE_OUT_OF_SCOPE" }, { status: 400 });
  }

  const normalized = {
    userId: session.userId,
    vehicleId,
    packageId: packageId || null,
    serviceType,
    location,
    lat: lat ?? null,
    lng: lng ?? null,
    date: date ? new Date(date).toISOString() : null,
    timeWindow: timeWindow || null,
    currentMileage: currentMileage ?? null,
  };
  const fingerprint = await requestFingerprint({ ...normalized, expectedPricingVersion: expectedPricingVersion ?? null });

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

  let pricing: Awaited<ReturnType<typeof calculatePrice>>;
  try {
    pricing = await calculatePrice({
      vehicleType: vehicle.type,
      serviceCode: "periodic",
      laborHours: 0,
      partsCost: 0,
      travelDistanceKm: 0,
      isEmergency: false,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "محاسبه تعرفه ممکن نیست", code: "PRICING_NOT_AVAILABLE" },
      { status: 409 },
    );
  }
  if (expectedPricingVersion !== pricing.pricingVersion) {
    return NextResponse.json(
      { error: "نرخ‌نامه پس از نمایش پیش‌فاکتور تغییر کرده است؛ لطفاً مبلغ جدید را بررسی کنید", code: "PRICING_VERSION_CHANGED" },
      { status: 409 },
    );
  }

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
  const maskedBookings = bookings.map((booking) => ({
    ...booking,
    package: booking.package ? maskFinancialFields(booking.package, ["basePrice"]) : booking.package,
  }));
  return NextResponse.json(liteResponse(maskedBookings, lite));
}
