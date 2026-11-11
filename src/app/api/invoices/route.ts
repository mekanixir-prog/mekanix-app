import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { areInvoicePriceSourcesVerified, areJobPartPriceSourcesVerified, isInvoicePricingPolicyApproved } from "@/lib/money/provenance";
import { maskInvoiceMoney } from "@/lib/money/read-provenance";

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
  return NextResponse.json(inv ? maskInvoiceMoney(inv) : null);
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
  if (!isInvoicePricingPolicyApproved()) {
    return NextResponse.json(
      { error: "سیاست نرخ‌گذاری ریالی هنوز تأیید نشده است؛ صدور فاکتور مسدود است", code: "INVOICE_PRICING_POLICY_UNAPPROVED" },
      { status: 409 },
    );
  }
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
  if (existingInvoice) return NextResponse.json(maskInvoiceMoney(existingInvoice));

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { parts: true, technician: true },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  if (!job.technician || !Array.isArray(job.parts)) {
    return NextResponse.json({ error: "اطلاعات مکانیک یا قطعات کار کامل نیست" }, { status: 409 });
  }
  if (!areInvoicePriceSourcesVerified(job.technician)) {
    return NextResponse.json(
      { error: "منشأ و واحد ریال هزینه‌های مکانیک تأیید نشده است؛ صدور فاکتور مسدود است", code: "TECHNICIAN_FEE_PROVENANCE_UNVERIFIED" },
      { status: 409 },
    );
  }
  if (!areJobPartPriceSourcesVerified(job.parts)) {
    return NextResponse.json(
      { error: "حداقل یک قطعه فاقد تأیید مستقل واحد ریال یا مبلغ صحیح امن است؛ صدور فاکتور مسدود است", code: "JOB_PART_CURRENCY_UNVERIFIED" },
      { status: 409 },
    );
  }
  if (job.status !== "WAITING_APPROVAL" && job.status !== "COMPLETED") {
    return NextResponse.json({ error: "فاکتور فقط پس از پایان عملیات تعمیر قابل صدور است" }, { status: 409 });
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
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0 ||
        !Number.isSafeInteger(quantity) || quantity <= 0) {
      return Number.NaN;
    }
    const lineTotal = unitPrice * quantity;
    const nextTotal = sum + lineTotal;
    return Number.isSafeInteger(lineTotal) && Number.isSafeInteger(nextTotal)
      ? nextTotal
      : Number.NaN;
  }, 0);

  if (!Number.isSafeInteger(laborRate) || laborRate < 0 ||
      !Number.isSafeInteger(travelFee) || travelFee < 0 ||
      !Number.isSafeInteger(partsTotal) || partsTotal < 0) {
    return NextResponse.json({ error: "مبالغ قیمت‌گذاری باید اعداد صحیح امن ریالی باشند" }, { status: 409 });
  }

  const laborTotal = laborHours * laborRate;
  const discount = 0;
  const subtotal = laborTotal + partsTotal + travelFee - discount;
  const taxSetting = await db.platformSetting.findUnique({ where: { key: "tax_rate" } });
  const taxRate = taxSetting?.value == null ? 0.09 : (taxSetting.value.trim() ? Number(taxSetting.value) : Number.NaN);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    return NextResponse.json({ error: "تنظیمات مالیات نامعتبر است" }, { status: 503 });
  }
  const taxTotal = subtotal * taxRate;
  const total = subtotal + taxTotal;
  if (![laborTotal, subtotal, taxTotal, total].every(Number.isSafeInteger) ||
      [laborTotal, subtotal, taxTotal, total].some((amount) => amount < 0)) {
    return NextResponse.json(
      { error: "تمام اجزای فاکتور و جمع نهایی باید اعداد صحیح امن ریالی باشند؛ گردکردن خودکار انجام نمی‌شود", code: "INVOICE_AMOUNT_NOT_INTEGER_IRR" },
      { status: 409 },
    );
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
        financialUnitStatus: "VERIFIED_IRR",
        status: "SENT",
        notes: "Invoice generated from independently verified IRR pricing sources.",
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
    if (racedInvoice) return NextResponse.json(maskInvoiceMoney(racedInvoice));
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
          body: `${tech?.name ?? "Mechanic"} issued an invoice. Review it to see the verified amount and payment details.`,
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
            body: `${invoice.code} was sent to ${cust.name} for review & payment.`,
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
          body: `Invoice ${invoice.code} issued.`,
        },
      });
    } catch (error) {
      console.error("[invoices] invoice notification failed:", error);
    }
  }
  return NextResponse.json(maskInvoiceMoney(invoice));
}
