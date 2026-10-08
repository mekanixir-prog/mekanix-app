import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, validateBody } from "@/lib/api-helpers";
import { getCustomerFromSession } from "@/lib/auth";
import { careBookingSchema } from "@/lib/schemas";
import { calculatePrice } from "@/lib/pricing";
import { checkVipStatus } from "@/lib/vip";
import { wantsLite, liteResponse } from "@/lib/lite-response";
import { runSequential } from "@/lib/db-sequential";

// POST /api/care/bookings — create a service booking.
//
// Pricing flow (per ARCHITECTURE.md §12):
//   1. Compute VIP discount percent (0 if no active VIP).
//   2. Compute the price via the pricing engine (`calculatePrice`):
//        FinalPrice = Labor + Parts + Travel + Emergency - Discount
//      At booking time, parts are unknown (0), and travel distance is
//      unknown (no technician dispatched yet → 0). The travel fee then
//      collapses to the base visit fee. After dispatch + inspection, the
//      snapshot can be refreshed with real parts + travel distance.
//   3. Persist the price as a frozen `PricingSnapshot` linked to the
//      booking — historical prices are immutable.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // Validate request body with Zod. vehicleId + location are required;
  // the rest (packageId, lat/lng, date, timeWindow, currentMileage) are
  // optional but type-checked if present. The schema also rejects negative
  // mileage and out-of-range lat/lng before we touch the DB.
  const body = await validateBody(req, careBookingSchema);
  if (!body.ok) return body.response;

  const { vehicleId, packageId, serviceType, location, lat, lng, date, timeWindow, currentMileage } = body.data;

  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });

  // Verify vehicle ownership
  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle || vehicle.customerId !== customer.id) {
    return NextResponse.json({ error: "خودرو متعلق به شما نیست" }, { status: 403 });
  }

  // ── Pricing ─────────────────────────────────────────────────────────
  // Use the new pricing engine (ARCHITECTURE.md §12). The booking-time
  // snapshot uses:
  //   - vehicle.type → drives the vehicle-type labor multiplier
  //   - laborHours = 1 (default estimate; re-priced after inspection)
  //   - partsCost = 0 (unknown at booking time)
  //   - travelDistanceKm = 0 (no technician dispatched yet)
  //   - isEmergency = serviceType === "emergency"
  //   - vipDiscountPercent = active VIP discount (0 if none)
  const vipStatus = await checkVipStatus(session.userId);

  const pricing = await calculatePrice({
    packageId: packageId || undefined,
    vehicleType: vehicle.type,
    laborHours: 1, // conservative booking-time estimate
    partsCost: 0, // unknown at booking time
    travelDistanceKm: 0, // no technician dispatched yet
    isEmergency: serviceType === "emergency",
    vipDiscountPercent: vipStatus.active ? vipStatus.discountPercent : 0,
  });

  // Create booking + pricing snapshot + timeline event as sequential writes
  // (D1 has no $transaction; earlier writes stay if a later one throws).
  //
  // The snapshot write is inlined here (rather than delegated to
  // `createPricingSnapshot()`) so it commits with the booking creation in
  // sequence. `createPricingSnapshot()` uses its own db handle which would
  // not be orderable relative to the booking insert.
  const code = `CARE-${Math.floor(100000 + Math.random() * 900000)}`;

  const booking = await db.serviceBooking.create({
    data: {
      code,
      userId: session.userId,
      vehicleId,
      packageId: packageId || null,
      serviceType: serviceType || "periodic",
      location,
      lat: lat || null,
      lng: lng || null,
      date: date ? new Date(date) : null,
      timeWindow: timeWindow || null,
      currentMileage: currentMileage || null,
      status: "REQUESTED",
    },
  });

  // Persist the frozen pricing snapshot (immutable, linked 1:1 to booking).
  const snapshot = await db.pricingSnapshot.create({
    data: {
      bookingId: booking.id,
      servicePrice: pricing.labor, // labor as service price
      visitPrice: pricing.travel,
      laborPrice: pricing.labor,
      partsPrice: pricing.parts,
      discount: pricing.discount,
      taxRate: pricing.taxRate,
      taxTotal: pricing.taxTotal,
      total: pricing.total,
      currency: pricing.currency,
      pricingVersion: pricing.pricingVersion,
    },
  });

  // Link snapshot to booking
  await db.serviceBooking.update({
    where: { id: booking.id },
    data: { pricingSnapshotId: snapshot.id },
  });

  // Create timeline event
  await db.serviceTimelineEvent.create({
    data: {
      bookingId: booking.id,
      eventType: "booking_created",
      actor: session.userId,
    },
  });

  return NextResponse.json(booking);
}

// GET /api/care/bookings — list user's bookings
export async function GET(req: Request) {
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
