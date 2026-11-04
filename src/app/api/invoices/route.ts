import { PARTICIPANT_USER_SELECT } from "@/lib/user-select";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { areInvoicePriceSourcesVerified } from "@/lib/money/provenance";
import { maskInvoiceFinancialData } from "@/lib/money/financial-read-mask";

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
  return NextResponse.json(inv ? maskInvoiceFinancialData(inv as unknown as Record<string, unknown>) : null);
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

  // Production invoice totals currently depend on technician profile fees.
  // Do not interpret legacy values as IRR until the rate card and fee units
  // have both been independently reconciled and explicitly approved.
  if (!areInvoicePriceSourcesVerified()) {
    return NextResponse.json(
      { error: "تعرفه یا واحد هزینه‌های مکانیک هنوز به‌عنوان ریال تأیید نشده است؛ صدور فاکتور پس از تطبیق مالی فعال می‌شود", code: "INVOICE_PRICE_PROVENANCE_UNVERIFIED" },
      { status: 409 },
    );
  }

  // Idempotent retry: the job-status flow may already have created this invoice.
  const existingInvoice = await db.invoice.findUnique({
    where: { jobId },
    include: FULL_INCLUDE,
  });
  if (existingInvoice) return NextResponse.json(maskInvoiceFinancialData(existingInvoice as unknown as Record<string, unknown>));

  // MEKANIX uses fixed labor fees. The current legacy writer derives labor
  // from hourlyRate × hours, so it must not issue a financial invoice until
  // the owner-approved fixed-fee rate card and calculation path are implemented.
  return NextResponse.json(
    { error: "مدل تعرفه دستمزد ثابت هنوز پیاده‌سازی و تأیید نشده است؛ صدور فاکتور مالی موقتاً مسدود است", code: "FIXED_LABOR_RATE_CARD_NOT_IMPLEMENTED" },
    { status: 409 },
  );

}
