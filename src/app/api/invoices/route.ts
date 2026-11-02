import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { calculatePrice, type PricingBreakdown } from "@/lib/pricing";
import { addIrr, assertIrrInteger } from "@/lib/money/irr";

const FULL_INCLUDE = {
  job: {
    include: {
      request: { include: { customer: { include: { user: true } }, vehicle: true } },
      technician: { include: { user: true } },
      parts: true,
      diagnosisRecords: true,
    },
  },
  payment: true,
} as const;

// GET: returns invoice by jobId. Caller must be a participant in the job (BOLA).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json(null);

  // Verify participation
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({ where: { jobId }, include: FULL_INCLUDE });
  return NextResponse.json(inv);
}

// POST: creates an invoice. Only the technician assigned to the job (or admin) may issue it.
// Server-authoritative: prices are computed from technician's rates + parts, NOT from client.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { jobId } = body;
  if (typeof jobId !== "string" || !jobId) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }

  // BOLA: must be participant (customer OR assigned tech) OR admin to even read this job
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  // Only the assigned technician (or admin) can issue an invoice
  const db = await getDbForLib();
  if (session.role === "TECHNICIAN") {
    const tech = await getTechnicianFromSession(session);
    const job = await db.job.findUnique({ where: { id: jobId }, select: { technicianId: true } });
    if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
    if (!tech || tech.id !== job.technicianId) {
      return NextResponse.json(
        { error: "فقط مکانیک مسئول کار می‌تواند فاکتور صادر کند" },
        { status: 403 }
      );
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // Server-authoritative pricing: the canonical integer-IRR engine is the
  // only source of invoice totals. Technician profile fee fields are legacy
  // and have mixed/unknown units, so they are deliberately not used here.
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { parts: true, request: { include: { vehicle: true } } },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  const laborHours = body.laborHours === undefined ? 1.5 : body.laborHours;
  if (typeof laborHours !== "number" || !Number.isFinite(laborHours) || laborHours < 0 || laborHours > 100) {
    return NextResponse.json({ error: "ساعت کار باید عددی بین صفر تا صد باشد" }, { status: 400 });
  }

  let partsTotal: number;
  try {
    const partAmounts = job.parts.map((part) => {
      if (!Number.isSafeInteger(part.quantity) || part.quantity < 1) {
        throw new RangeError("Part quantity must be a positive safe integer");
      }
      const unitPrice = Number(part.unitPrice);
      assertIrrInteger(unitPrice, "Part unit price");
      const lineTotal = unitPrice * part.quantity;
      assertIrrInteger(lineTotal, "Part line total");
      return lineTotal;
    });
    partsTotal = addIrr(...partAmounts);
  } catch {
    return NextResponse.json(
      { error: "قیمت یا تعداد یکی از قطعات معتبر نیست؛ مبلغ باید عدد صحیح ریالی باشد" },
      { status: 400 }
    );
  }

  const taxSetting = await db.platformSetting.findUnique({ where: { key: "tax_rate" } });
  const taxRate = taxSetting?.value ? Number(taxSetting.value) : 0.09;
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    return NextResponse.json({ error: "تنظیم نرخ مالیات نامعتبر است" }, { status: 500 });
  }

  let price: PricingBreakdown;
  try {
    price = await calculatePrice({
      vehicleType: job.request.vehicle.type,
      laborHours,
      partsCost: partsTotal,
      // Until route-distance pricing is connected, only the canonical base visit fee applies.
      travelDistanceKm: 0,
      isEmergency: false,
      taxRate,
    });
  } catch (error) {
    console.error("[invoices] Canonical pricing failed", error);
    return NextResponse.json({ error: "محاسبه قیمت فاکتور ناموفق بود" }, { status: 400 });
  }

  const code = `INV-${Math.floor(3000 + Math.random() * 6000)}`;
  const inv = await db.invoice.upsert({
    where: { jobId },
    create: {
      code,
      jobId,
      laborHours,
      laborRate: price.breakdown.laborRate,
      laborTotal: price.labor,
      partsTotal: price.parts,
      travelFee: price.travel,
      discount: price.discount,
      subtotal: price.subtotal,
      taxRate: price.taxRate,
      taxTotal: price.taxTotal,
      total: price.total,
      currency: "IRR",
      status: "SENT",
      notes: "Parts & labor covered by 6-month MEKANIX warranty.",
    },
    update: {},
    include: FULL_INCLUDE,
  });

  // Notify BOTH the customer and the mechanic that the invoice was issued.
  const refreshed = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { customer: { include: { user: true } } } },
      technician: { include: { user: true } },
    },
  });
  if (refreshed) {
    const cust = refreshed.request.customer.user;
    const tech = refreshed.technician?.user;
    await db.notification.create({
      data: {
        userId: cust.id,
        type: "invoice_issued",
        title: `Invoice ${inv.code} issued`,
        body: `${tech?.name ?? "Mechanic"} issued invoice for ${Number(inv.total)} ${inv.currency}. Review and pay to complete the job.`,
        category: "payment",
        link: "customer/invoice",
      },
    });
    if (tech) {
      await db.notification.create({
        data: {
          userId: tech.id,
          type: "invoice_issued",
          title: `Invoice ${inv.code} sent to customer`,
          body: `${inv.code} for ${Number(inv.total)} ${inv.currency} was sent to ${cust.name} for review & payment.`,
          category: "payment",
          link: "technician/earnings",
        },
      });
    }
    await db.message.create({
      data: {
        jobId: refreshed.id,
        fromUserId: tech?.id ?? cust.id,
        kind: "system",
        body: `Invoice ${inv.code} issued — total ${Number(inv.total)} ${inv.currency}.`,
      },
    });
  }
  return NextResponse.json(inv);
}
