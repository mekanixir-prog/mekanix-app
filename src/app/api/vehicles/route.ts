import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth, validateBody } from "@/lib/api-helpers";
import { getCustomerFromSession, sanitizeInput, ALLOWED_FIELDS } from "@/lib/auth";
import { vehicleCreateSchema } from "@/lib/schemas";

export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // Derive customer from session — ignore any client-supplied customerId
  const db = await getDbForLib();
  if (session.role === "ADMIN") {
    // Admins can list all vehicles (used by admin portal)
    const vehicles = await db.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      include: { customer: { include: { user: true } } },
    });
    return NextResponse.json(vehicles);
  }

  if (session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });

  const vehicles = await db.vehicle.findMany({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(vehicles);
}

export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "فقط مشتریان می‌توانند خودرو ثبت کنند" }, { status: 403 });
  }

  const customer = await getCustomerFromSession(session);
  if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });

  // Validate request body with Zod. The schema enforces type/make/model/year
  // presence and bounds, and validates optional lat/lng ranges. We keep the
  // existing sanitizeInput() mass-assignment whitelist as defence-in-depth —
  // it strips any extra fields the schema happened to allow through (none,
  // today, but cheap insurance against future schema additions).
  const body = await validateBody(req, vehicleCreateSchema);
  if (!body.ok) return body.response;

  const safe = sanitizeInput(body.data as unknown as Record<string, any>, ALLOWED_FIELDS.vehicle);
  if (!safe.type || !safe.make || !safe.model || !safe.year) {
    return NextResponse.json({ error: "نوع، برند، مدل و سال الزامی است" }, { status: 400 });
  }

  // customerId is server-authoritative — NEVER trust client
  const db = await getDbForLib();
  const vehicle = await db.vehicle.create({
    data: { ...(safe as any), customerId: customer.id },
  });
  return NextResponse.json(vehicle);
}
