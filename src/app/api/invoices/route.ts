import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { areJobPartPriceSourcesVerified } from "@/lib/money/provenance";
import { calculatePrice } from "@/lib/pricing";
import type { ServiceCode } from "@/lib/pricing-rate-card";

const FULL_INCLUDE = {
  job: {
    include: {
      request: { include: { customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } }, vehicle: true } },
      technician: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
      parts: true,
      diagnosisRecords: true,
    },
  },
  payment: true,
} as const;


function serviceCodeFromCategory(category: string): ServiceCode {
  const value = category.toLowerCase();
  if (value.includes("hydraulic") || value.includes("هیدرولیک")) return "hydraulic";
  if (value.includes("elect") || value.includes("برق") || value.includes("سیم")) return "electrical";
  if (value.includes("cool") || value.includes("کولر") || value.includes("خنک") || value.includes("رادیات")) return "cooling";
  if (value.includes("brake") || value.includes("suspension") || value.includes("ترمز") || value.includes("تعلیق") || value.includes("جلوبندی")) return "brakes";
  if (value.includes("periodic") || value.includes("maintenance") || value.includes("سرویس") || value.includes("دوره")) return "periodic";
  if (value.includes("engine") || value.includes("motor") || value.includes("موتور")) {
    return value.includes("major") || value.includes("اساسی") || value.includes("کامل") ? "engine_major" : "engine_minor";
  }
  if (value.includes("transmission") || value.includes("gearbox") || value.includes("گیربکس") || value.includes("انتقال قدرت")) return "transmission";
  if (value.includes("undercarriage") || value.includes("chassis") || value.includes("زیربندی") || value.includes("شاسی")) return "undercarriage";
  return "diagnostic";
}

function estimateTravelDistanceKm(
  from: { lat: number; lng: number },
  to: { lat: number | null; lng: number | null },
): number {
  if (to.lat === null || to.lng === null ||
      ![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) return 0;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  const straightLineKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  // Approximate road distance from the technician's last reported location.
  return Math.ceil(straightLineKm * 1.3);
}

// GET: returns invoice by jobId. Caller must be a participant in the job (BOLA).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json(null);

  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({ where: { jobId }, include: FULL_INCLUDE });
  return NextResponse.json(inv);
}

// POST: only the assigned technician or an admin may issue an invoice.
// Amounts are calculated exclusively from persisted job/technician/parts data.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const body = rawBody as Record<string, unknown>;
  const jobId = body.jobId;
  if (typeof jobId !== "string" || !jobId.trim()) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }

  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  if (session.role === "TECHNICIAN") {
    const tech = await getTechnicianFromSession(session);
    const job = await db.job.findUnique({ where: { id: jobId }, select: { technicianId: true } });
    if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
    if (!tech || tech.id !== job.technicianId) {
      return NextResponse.json(
        { error: "فقط مکانیک مسئول کار می‌تواند فاکتور صادر کند" },
        { status: 403 },
      );
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // Idempotent retry: the job-status flow may already have created this invoice.
  const existingInvoice = await db.invoice.findUnique({
    where: { jobId },
    include: FULL_INCLUDE,
  });
  if (existingInvoice) return NextResponse.json(existingInvoice);

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: {
      parts: true,
      technician: true,
      tracking: { orderBy: { ts: "desc" }, take: 1 },
      request: { include: { vehicle: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  if (!areJobPartPriceSourcesVerified(job.parts.length > 0)) {
    return NextResponse.json(
      { error: "واحد قیمت قطعات قدیمی هنوز به ریال تطبیق داده نشده است؛ صدور فاکتور پس از تأیید سوابق قطعات فعال می‌شود", code: "JOB_PART_CURRENCY_UNVERIFIED" },
      { status: 409 },
    );
  }
  if (job.status !== "WAITING_APPROVAL" && job.status !== "COMPLETED") {
    return NextResponse.json({ error: "فاکتور فقط پس از پایان عملیات تعمیر قابل صدور است" }, { status: 409 });
  }
  if (!job.technician || !Array.isArray(job.parts) || !job.request?.vehicle) {
    return NextResponse.json({ error: "اطلاعات مکانیک، وسیله یا قطعات کار کامل نیست" }, { status: 409 });
  }

  const partsTotal = job.parts.reduce((sum, part) => {
    const unitPrice = Number(part.unitPrice);
    const quantity = Number(part.quantity);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 ||
        !Number.isSafeInteger(quantity) || quantity < 0) return Number.NaN;
    const next = sum + unitPrice * quantity;
    return Number.isSafeInteger(next) ? next : Number.NaN;
  }, 0);
  if (!Number.isSafeInteger(partsTotal) || partsTotal < 0) {
    return NextResponse.json({ error: "مبلغ قطعات باید ریال صحیح و تأییدشده باشد" }, { status: 409 });
  }

  const serviceCode = serviceCodeFromCategory(job.request.category);
  const latestTrackedLocation = job.tracking[0] ?? job.technician;
  const travelDistanceKm = estimateTravelDistanceKm(
    { lat: latestTrackedLocation.lat, lng: latestTrackedLocation.lng },
    { lat: job.request.lat, lng: job.request.lng },
  );
  let pricing: Awaited<ReturnType<typeof calculatePrice>>;
  try {
    pricing = await calculatePrice({
      vehicleType: job.request.vehicle.type,
      serviceCode,
      laborHours: 1,
      partsCost: partsTotal,
      travelDistanceKm,
      isEmergency: job.request.urgency === "EMERGENCY",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "محاسبه تعرفه ممکن نیست", code: "PRICING_NOT_AVAILABLE" },
      { status: 409 },
    );
  }
  const laborHours = 1;
  const laborRate = pricing.labor;
  const laborTotal = pricing.labor;
  const travelFee = pricing.travel;
  const inspectionFee = pricing.inspection;
  const emergencyFee = pricing.emergency;
  const subtotal = pricing.subtotal;
  const taxRate = pricing.taxRate;
  const taxTotal = pricing.taxTotal;
  const discount = pricing.discount;
  const total = pricing.total;

  const code = `INV-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  let invoice: any;
  try {
    invoice = await db.invoice.create({
      data: {
        code,
        jobId,
        laborHours,
        laborRate,
        laborTotal,
        partsTotal,
        travelFee,
        inspectionFee,
        emergencyFee,
        discount,
        subtotal,
        taxRate,
        taxTotal,
        total,
        currency: "IRR",
        financialUnitStatus: "VERIFIED_IRR",
        status: "SENT",
        notes: `Fixed-fee rate card ${pricing.pricingVersion}; service ${serviceCode}; estimated technician travel ${travelDistanceKm} km. Parts & labor covered by 6-month MEKANIX warranty.`,
      },
      include: FULL_INCLUDE,
    });
  } catch (error) {
    // A concurrent request or the job-status transition may win the unique
    // Invoice.jobId constraint. Return that committed invoice instead of 500.
    const racedInvoice = await db.invoice.findUnique({
      where: { jobId },
      include: FULL_INCLUDE,
    }).catch(() => null);
    if (racedInvoice) return NextResponse.json(racedInvoice);
    throw error;
  }

  // Notifications are post-commit and best-effort; a delivery failure must not
  // turn a successfully issued invoice into an apparent failed request.
  const refreshed = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { customer: { include: { user: { select: PARTICIPANT_USER_SELECT } } } } },
      technician: { include: { user: { select: PARTICIPANT_USER_SELECT } } },
    },
  });
  if (refreshed) {
    const cust = refreshed.request.customer.user;
    const tech = refreshed.technician?.user;
    try {
      await db.notification.create({
        data: {
          userId: cust.id,
          type: "invoice_issued",
          title: `Invoice ${invoice.code} issued`,
          body: `${tech?.name ?? "Mechanic"} issued invoice for ${Number(invoice.total)}. Review and pay to complete the job.`,
          category: "payment",
          link: "customer/invoice",
        },
      });
      if (tech) {
        await db.notification.create({
          data: {
            userId: tech.id,
            type: "invoice_issued",
            title: `Invoice ${invoice.code} sent to customer`,
            body: `${invoice.code} for ${Number(invoice.total)} was sent to ${cust.name} for review & payment.`,
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
          body: `Invoice ${invoice.code} issued — total ${Number(invoice.total)} ${invoice.currency}.`,
        },
      });
    } catch (error) {
      console.error("[invoices] invoice notification failed:", error);
    }
  }
  return NextResponse.json(invoice);
}
