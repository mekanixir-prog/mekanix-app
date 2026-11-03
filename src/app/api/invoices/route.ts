import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";

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
    include: { parts: true, technician: true },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  if (job.status !== "WAITING_APPROVAL" && job.status !== "COMPLETED") {
    return NextResponse.json({ error: "فاکتور فقط پس از پایان عملیات تعمیر قابل صدور است" }, { status: 409 });
  }
  if (!job.technician || !Array.isArray(job.parts)) {
    return NextResponse.json({ error: "اطلاعات مکانیک یا قطعات کار کامل نیست" }, { status: 409 });
  }

  const laborHoursRaw = body.laborHours === undefined ? 1.5 : body.laborHours;
  if (
    typeof laborHoursRaw !== "number" ||
    !Number.isFinite(laborHoursRaw) ||
    laborHoursRaw <= 0 ||
    laborHoursRaw > 24
  ) {
    return NextResponse.json({ error: "مدت کار باید عددی بزرگ‌تر از ۰ و حداکثر ۲۴ ساعت باشد" }, { status: 400 });
  }
  const laborHours = laborHoursRaw;
  const laborRate = Number(job.technician.hourlyRate);
  const travelFee = Number(job.technician.travelFeeBase);
  const partsTotal = job.parts.reduce((sum, part) => {
    const unitPrice = Number(part.unitPrice);
    const quantity = Number(part.quantity);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 ||
        !Number.isSafeInteger(quantity) || quantity < 0) {
      return Number.NaN;
    }
    return sum + unitPrice * quantity;
  }, 0);

  if (!Number.isFinite(laborRate) || laborRate < 0 ||
      !Number.isFinite(travelFee) || travelFee < 0 ||
      !Number.isFinite(partsTotal) || partsTotal < 0) {
    return NextResponse.json({ error: "اطلاعات قیمت‌گذاری کار نامعتبر است" }, { status: 409 });
  }

  const laborTotal = laborHours * laborRate;
  const discount = 0;
  const subtotal = laborTotal + partsTotal + travelFee - discount;
  const taxSetting = await db.platformSetting.findUnique({ where: { key: "tax_rate" } });
  const taxRate = taxSetting?.value == null ? 0.09 : Number(taxSetting.value);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    return NextResponse.json({ error: "تنظیمات مالیات نامعتبر است" }, { status: 503 });
  }
  const taxTotal = subtotal * taxRate;
  const total = subtotal + taxTotal;
  if (![laborTotal, subtotal, taxTotal, total].every(Number.isFinite)) {
    return NextResponse.json({ error: "محاسبه مبلغ فاکتور نامعتبر است" }, { status: 409 });
  }

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
        discount,
        subtotal,
        taxRate,
        taxTotal,
        total,
        currency: "IRR",
        status: "SENT",
        notes: "Parts & labor covered by 6-month MEKANIX warranty.",
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
      request: { include: { customer: { include: { user: true } } } },
      technician: { include: { user: true } },
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
