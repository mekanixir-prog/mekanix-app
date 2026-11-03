import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant } from "@/lib/auth";

// PATCH /api/invoices/[id]
// Customer can: APPROVE (set customerApproved flag), MARK_PAID (pay invoice — but actual payment
//   flows through /api/payments). Customer CANNOT change amounts or status to PAID directly.
// Technician/Admin can: edit notes only (amounts are server-authoritative — see /api/invoices POST).
// Status transitions to PAID happen only via /api/payments after gateway verification.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  // Resolve invoice + job so we can check ownership/participation
  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({
    where: { id },
    select: { id: true, jobId: true, status: true, total: true, currency: true, code: true },
  });
  if (!inv) return NextResponse.json({ error: "فاکتور یافت نشد" }, { status: 404 });

  // BOLA: must be participant in the linked job (or admin)
  const access = await requireJobParticipant(session, inv.jobId);
  if (access) return access;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Whitelist allowed fields based on role
  const allowedUpdates: Record<string, any> = {};

  // FORBIDDEN for everyone via this route (server-authoritative only):
  // - laborHours, laborRate, laborTotal, partsTotal, travelFee, subtotal, taxRate, taxTotal, total
  // - status (PAID is set only via /api/payments after successful gateway verify)
  // - currency

  // Notes can be edited by technician or admin
  if (typeof body.notes === "string" && body.notes.length <= 2000) {
    if (session.role === "TECHNICIAN" || session.role === "ADMIN") {
      allowedUpdates.notes = body.notes.slice(0, 2000);
    }
  }

  // Customer can mark customerApproved (approve the repair estimate)
  if (typeof body.customerApproved === "boolean" && session.role === "CUSTOMER") {
    // Only allow approving — never un-approving once approved (defensive; the invoice itself
    // doesn't store this but the job does — handled by /api/jobs/[id]/status)
    // We don't expose customerApproved on the Invoice model; redirect this to the job.
    if (body.customerApproved === true) {
      await db.job.update({
        where: { id: inv.jobId },
        data: { customerApproved: true },
      });
    }
  }

  // Status transitions: explicit PAID is forbidden here (must go through /api/payments).
  // Allow DRAFT → SENT only for technician/admin (re-issue).
  if (typeof body.status === "string" && (session.role === "TECHNICIAN" || session.role === "ADMIN")) {
    if (body.status === "SENT" && inv.status === "DRAFT") {
      allowedUpdates.status = "SENT";
    } else if (body.status === "CANCELLED") {
      allowedUpdates.status = "CANCELLED";
    } else {
      return NextResponse.json(
        { error: "تغییر وضعیت فاکتور مجاز نیست — برای پرداخت از /api/payments استفاده کنید" },
        { status: 403 }
      );
    }
  } else if (typeof body.status === "string" && session.role === "CUSTOMER") {
    if (body.status === "PAID") {
      return NextResponse.json(
        { error: "مشتری نمی‌تواند فاکتور را مستقیماً پرداخت‌شده علامت بزند — از /api/payments استفاده کنید" },
        { status: 403 }
      );
    }
  }

  if (Object.keys(allowedUpdates).length === 0) {
    // Nothing to update — return current state
    const fresh = await db.invoice.findUnique({ where: { id }, include: { job: true, payment: true } });
    return NextResponse.json(fresh);
  }

  const updated = await db.invoice.update({
    where: { id },
    data: allowedUpdates,
    include: { job: true, payment: true },
  });
  return NextResponse.json(updated);
}
