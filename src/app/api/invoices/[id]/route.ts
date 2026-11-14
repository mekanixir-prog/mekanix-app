import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";
import { maskInvoiceFinancialData } from "@/lib/money/financial-read-mask";
import { JobStatusConflictError, transitionJobStatusAtomically } from "@/lib/job-status-atomic";

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
    select: {
      id: true,
      jobId: true,
      status: true,
      total: true,
      currency: true,
      code: true,
      financialUnitStatus: true,
      job: {
        select: {
          status: true,
          customerApproved: true,
          updatedAt: true,
          technicianId: true,
          requestId: true,
        },
      },
    },
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

  const hasCustomerApproval = Object.prototype.hasOwnProperty.call(input, "customerApproved");
  if (hasCustomerApproval) {
    if (session.role !== "CUSTOMER") {
      return NextResponse.json({ error: "فقط مشتری می‌تواند پیش‌فاکتور را تأیید کند" }, { status: 403 });
    }
    if (input.customerApproved !== true || Object.keys(input).some((key) => key !== "customerApproved")) {
      return NextResponse.json({ error: "تأیید مشتری باید به‌صورت Boolean واقعی و در درخواست مستقل ارسال شود" }, { status: 400 });
    }
    if (inv.status !== "SENT" || inv.currency !== "IRR" || inv.financialUnitStatus !== "VERIFIED_IRR") {
      return NextResponse.json({ error: "فقط پیش‌فاکتور معتبر و تأییدشده با وضعیت ارسال‌شده قابل تأیید است", code: "REPAIR_ESTIMATE_REQUIRED" }, { status: 409 });
    }
    if (inv.job.status !== "WAITING_APPROVAL" || !inv.job.technicianId || !inv.job.requestId) {
      return NextResponse.json({ error: "وضعیت کار برای تأیید پیش‌فاکتور آماده نیست", code: "CUSTOMER_APPROVAL_STATE_INVALID" }, { status: 409 });
    }
    if (!inv.job.customerApproved) {
      try {
        await transitionJobStatusAtomically(db, {
          jobId: inv.jobId,
          requestId: inv.job.requestId,
          technicianId: inv.job.technicianId,
          actorRole: "CUSTOMER",
          actorTechnicianId: null,
          currentStatus: inv.job.status,
          expectedUpdatedAt: inv.job.updatedAt,
          nextStatus: inv.job.status,
          updates: { customerApproved: true },
        });
      } catch (error) {
        if (error instanceof JobStatusConflictError) {
          return NextResponse.json({ error: "وضعیت کار هم‌زمان تغییر کرده است؛ دوباره تلاش کنید" }, { status: 409 });
        }
        throw error;
      }
    }
    const fresh = await db.invoice.findUnique({
      where: { id },
      include: { job: true, payment: true },
    });
    return NextResponse.json(fresh ? maskInvoiceFinancialData(fresh as unknown as Record<string, unknown>) : null);
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
