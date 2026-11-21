import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import {
  requireBookingOwner,
  isValidTransition,
  isValidApprovalTransition,
} from "@/lib/care-auth";
import {
  CareExtraApprovalConflictError,
  decideCareExtraApprovalAtomically,
} from "@/lib/care-extra-approval-atomic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه JSON نامعتبر است" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const approvalId = (body as Record<string, unknown>).approvalId;
  if (typeof approvalId !== "string" || !approvalId.trim() || approvalId.length > 128) {
    return NextResponse.json({ error: "شناسه تأییدیه معتبر الزامی است" }, { status: 400 });
  }

  const authz = await requireBookingOwner(session, id);
  if (authz) return authz;

  const db = await getDbForLib();
  const booking = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!booking) return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });

  const approval = await db.customerApproval.findUnique({ where: { id: approvalId } });
  if (!approval) return NextResponse.json({ error: "تأییدیه یافت نشد" }, { status: 404 });
  if (approval.bookingId !== id) {
    return NextResponse.json({ error: "این تأییدیه متعلق به این سفارش نیست" }, { status: 403 });
  }

  if (approval.financialUnitStatus !== "VERIFIED_IRR") {
    return NextResponse.json({ error: "واحد و منشأ مالی این پیشنهاد تأیید نشده است", code: "CARE_EXTRA_PRICE_PROVENANCE_UNVERIFIED" }, { status: 409 });
  }
  if (!isValidApprovalTransition(approval.status, "CUSTOMER_APPROVED")) {
    return NextResponse.json(
      {
        error: `امکان تأیید پیشنهاد در وضعیت ${approval.status} وجود ندارد`,
        currentStatus: approval.status,
      },
      { status: 409 },
    );
  }
  if (!isValidTransition(session.role, booking.status, "APPROVED")) {
    return NextResponse.json(
      {
        error: `انتقال وضعیت مجاز نیست: ${booking.status} → APPROVED برای نقش ${session.role}`,
        currentStatus: booking.status,
        nextStatus: "APPROVED",
      },
      { status: 409 },
    );
  }

  try {
    const updatedApproval = await decideCareExtraApprovalAtomically(db, {
      bookingId: id,
      approvalId,
      findingId: approval.findingId,
      actorUserId: session.userId,
      decision: "CUSTOMER_APPROVED",
    });
    return NextResponse.json({ ok: true, approval: maskFinancialFields(updatedApproval, ["partPrice", "laborPrice", "totalPrice"]) });
  } catch (error) {
    if (error instanceof CareExtraApprovalConflictError) {
      return NextResponse.json(
        { error: "وضعیت پیشنهاد یا سفارش هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کنید" },
        { status: 409 },
      );
    }
    throw error;
  }
}
