import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";
import { maskInvoiceFinancialData } from "@/lib/money/financial-read-mask";

// PATCH /api/invoices/[id]
// Amounts and currency are server-authoritative. PAID is written only by the
// verified payment lifecycle. InvoiceStatus currently has no CANCELLED value;
// unsupported cancellation is rejected rather than sending an invalid Prisma enum.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({
    where: { id },
    select: { id: true, jobId: true, status: true, total: true, currency: true, code: true, financialUnitStatus: true },
  });
  if (!inv) return NextResponse.json({ error: "فاکتور یافت نشد" }, { status: 404 });

  const access = await requireJobParticipant(session, inv.jobId);
  if (access) return access;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const allowedUpdates: Record<string, unknown> = {};

  if (typeof input.notes === "string" && input.notes.length <= 2000 &&
      (session.role === "TECHNICIAN" || session.role === "ADMIN")) {
    allowedUpdates.notes = input.notes;
  }

  let statusTransitionRequested = false;
  if (typeof input.status === "string") {
    if (session.role === "TECHNICIAN" || session.role === "ADMIN") {
      if (input.status === "SENT" && inv.status === "DRAFT") {
        allowedUpdates.status = "SENT";
        statusTransitionRequested = true;
      } else {
        // In particular, CANCELLED is not a member of InvoiceStatus and PAID
        // must never be set through this route.
        return NextResponse.json(
          { error: "تغییر وضعیت فاکتور مجاز نیست — برای پرداخت از مسیر پرداخت تأییدشده استفاده کنید" },
          { status: 403 },
        );
      }
    } else if (session.role === "CUSTOMER" && input.status === "PAID") {
      return NextResponse.json(
        { error: "مشتری نمی‌تواند فاکتور را مستقیماً پرداخت‌شده علامت بزند" },
        { status: 403 },
      );
    }
  }

  if (input.customerApproved === true) {
    if (session.role !== "CUSTOMER") {
      return NextResponse.json(
        { error: "فقط مشتری مالک درخواست می‌تواند پیش‌فاکتور را تأیید کند", code: "CUSTOMER_APPROVAL_FORBIDDEN" },
        { status: 403 },
      );
    }
    if (inv.status !== "SENT" || inv.currency !== "IRR" ||
        inv.financialUnitStatus !== "VERIFIED_IRR" ||
        !Number.isSafeInteger(Number(inv.total)) || Number(inv.total) <= 0) {
      return NextResponse.json(
        { error: "فقط پیش‌فاکتور صادرشده و دارای مبلغ ریالی تأییدشده قابل تأیید است", code: "REPAIR_ESTIMATE_NOT_PAYABLE" },
        { status: 409 },
      );
    }
    const approved = await db.job.updateMany({
      where: { id: inv.jobId, status: "WAITING_APPROVAL", customerApproved: false },
      data: { customerApproved: true },
    });
    if (approved.count !== 1) {
      return NextResponse.json(
        { error: "وضعیت کار برای تأیید پیش‌فاکتور معتبر نیست یا قبلاً تغییر کرده است", code: "JOB_APPROVAL_STATE_CONFLICT" },
        { status: 409 },
      );
    }
  }

  if (Object.keys(allowedUpdates).length === 0) {
    const fresh = await db.invoice.findUnique({
      where: { id },
      include: { job: true, payment: true },
    });
    return NextResponse.json(fresh ? maskInvoiceFinancialData(fresh as unknown as Record<string, unknown>) : null);
  }

  if (statusTransitionRequested) {
    const changed = await db.invoice.updateMany({
      where: { id, status: inv.status },
      data: allowedUpdates,
    });
    if (changed.count !== 1) {
      return NextResponse.json(
        { error: "وضعیت فاکتور هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کنید" },
        { status: 409 },
      );
    }
    const fresh = await db.invoice.findUnique({
      where: { id },
      include: { job: true, payment: true },
    });
    return NextResponse.json(fresh ? maskInvoiceFinancialData(fresh as unknown as Record<string, unknown>) : null);
  }

  const updated = await db.invoice.update({
    where: { id },
    data: allowedUpdates,
    include: { job: true, payment: true },
  });
  return NextResponse.json(maskInvoiceFinancialData(updated as unknown as Record<string, unknown>));
}
