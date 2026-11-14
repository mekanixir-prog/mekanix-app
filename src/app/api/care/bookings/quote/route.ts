import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getCustomerFromSession } from "@/lib/auth";
import { calculatePrice } from "@/lib/pricing";

// POST /api/care/bookings/quote — authenticated, owner-scoped CARE quote.
// The quote uses the same server-side rate card as booking and invoice calculation.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (typeof input.vehicleId !== "string" || !input.vehicleId.trim()) {
    return NextResponse.json({ error: "شناسه وسیله الزامی است" }, { status: 400 });
  }
  if (input.serviceType !== undefined && input.serviceType !== "periodic") {
    return NextResponse.json({ error: "این مسیر فقط برای رزرو سرویس دوره‌ای است" }, { status: 400 });
  }

  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });

  const db = await getDbForLib();
  const vehicle = await db.vehicle.findUnique({ where: { id: input.vehicleId } });
  if (!vehicle || vehicle.customerId !== customer.id) {
    return NextResponse.json({ error: "وسیله متعلق به شما نیست" }, { status: 403 });
  }

  try {
    const pricing = await calculatePrice({
      vehicleType: vehicle.type,
      serviceCode: "periodic",
      laborHours: 0,
      partsCost: 0,
      travelDistanceKm: 0,
      isEmergency: false,
    });
    return NextResponse.json({
      pricing: {
        labor: pricing.labor,
        travel: pricing.travel,
        inspection: pricing.inspection,
        emergency: pricing.emergency,
        taxRate: pricing.taxRate,
        taxTotal: pricing.taxTotal,
        total: pricing.total,
        currency: pricing.currency,
        pricingVersion: pricing.pricingVersion,
        breakdown: { includedDistanceKm: pricing.breakdown.includedDistanceKm },
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "محاسبه تعرفه ممکن نیست", code: "PRICING_NOT_AVAILABLE" },
      { status: 409 },
    );
  }
}
