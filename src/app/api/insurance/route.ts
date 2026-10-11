import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { sanitizeInput, ALLOWED_FIELDS } from "@/lib/auth";

// GET: list insurance policies for the authenticated user (+ their claims).
// userId is derived from session — the `userId` query param is IGNORED (BOLA protection).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const userId = session.userId;
  const db = await getDbForLib();

  // Expire policies past their endDate
  const now = new Date();
  await db.insurancePolicy.updateMany({
    where: { userId, status: "active", endDate: { lt: now } },
    data: { status: "expired" },
  });

  const policies = await db.insurancePolicy.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { vehicle: true, claims: { orderBy: { createdAt: "desc" } } },
  });
  return NextResponse.json(policies);
}

// POST: add a new insurance policy.
// userId is derived from session — NEVER from request body.
// Body is sanitized to only allow whitelisted insurance fields (mass-assignment protection).
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const safe = sanitizeInput(body, ALLOWED_FIELDS.insurance);
  if (!safe.provider || !safe.policyNumber || !safe.startDate || !safe.endDate) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const db = await getDbForLib();

  // If vehicleId provided, ensure the user owns it
  if (safe.vehicleId) {
    const vehicle = await db.vehicle.findUnique({
      where: { id: safe.vehicleId },
      select: { customerId: true },
    });
    if (!vehicle) return NextResponse.json({ error: "خودرو یافت نشد" }, { status: 404 });
    // Look up the customer profile for this user
    const customer = await db.customer.findUnique({ where: { userId: session.userId } });
    if (!customer || vehicle.customerId !== customer.id) {
      return NextResponse.json({ error: "خودرو متعلق به این کاربر نیست" }, { status: 403 });
    }
  }

  const code = `POL-${Math.floor(6000 + Math.random() * 3000)}`;
  const startDate = new Date(safe.startDate);
  const endDate = new Date(safe.endDate);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "تاریخ نامعتبر" }, { status: 400 });
  }

  const policy = await db.insurancePolicy.create({
    data: {
      code,
      userId: session.userId, // server-authoritative
      vehicleId: safe.vehicleId ?? null,
      provider: String(safe.provider).slice(0, 100),
      policyNumber: String(safe.policyNumber).slice(0, 100),
      type: ["third-party", "comprehensive", "zero"].includes(safe.type) ? safe.type : "third-party",
      startDate,
      endDate,
      premiumAmount: typeof safe.premiumAmount === "number" ? safe.premiumAmount : parseFloat(safe.premiumAmount) || 0,
      coverageAmount: typeof safe.coverageAmount === "number" ? safe.coverageAmount : parseFloat(safe.coverageAmount) || 0,
      notes: typeof safe.notes === "string" ? safe.notes.slice(0, 1000) : null,
      status: endDate > new Date() ? "active" : "expired",
    },
    include: { vehicle: true },
  });
  return NextResponse.json(policy);
}
