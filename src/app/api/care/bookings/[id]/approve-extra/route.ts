// MEKANIX CARE — Approve extra cost proposal (customer)
//
// Security:
//   - requireAuth (any authenticated user)
//   - requireBookingOwner — only the customer who owns the booking (or ADMIN) may approve.
//   - Approval record must belong to this booking (BOLA: customers cannot approve
//     approvals belonging to other customers' bookings).
//   - Approval.status must be PROPOSED — cannot approve an already-approved/rejected record.
//   - Booking must currently be WAITING_CUSTOMER_APPROVAL (state-machine enforced).
//
// Atomicity:
//   - D1 does NOT support db.$transaction; CustomerApproval update, Finding
//     update, ServiceBooking status update, and ServiceTimelineEvent create
//     run sequentially via db.* directly. If a later write fails, earlier
//     writes stay (acceptable for D1).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-helpers";
import {
  requireBookingOwner,
  isValidTransition,
  isValidApprovalTransition,
} from "@/lib/care-auth";
import { runSequential } from "@/lib/db-sequential";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  const body = await req.json();
  const { approvalId } = body;

  if (!approvalId) {
    return NextResponse.json(
      { error: "approvalId الزامی است" },
      { status: 400 }
    );
  }

  // Authorization: booking owner (customer) or ADMIN.
  // Replaces the manual booking.userId === session.userId check.
  const authz = await requireBookingOwner(session, id);
  if (authz) return authz;

  // Fetch the booking (we need its current status for state-machine validation).
  const booking = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  // Fetch the approval record.
  const approval = await db.customerApproval.findUnique({
    where: { id: approvalId },
  });
  if (!approval) {
    return NextResponse.json(
      { error: "تأییدیه یافت نشد" },
      { status: 404 }
    );
  }

  // BOLA: approval must belong to this booking — a customer cannot approve an
  // approval that belongs to a different booking (even one they own, since the
  // URL path identifies the booking under action).
  if (approval.bookingId !== id) {
    return NextResponse.json(
      { error: "این تأییدیه متعلق به این سفارش نیست" },
      { status: 403 }
    );
  }

  // Approval state machine: only PROPOSED → CUSTOMER_APPROVED is allowed.
  if (!isValidApprovalTransition(approval.status, "CUSTOMER_APPROVED")) {
    return NextResponse.json(
      {
        error: `امکان تأیید پیشنهاد در وضعیت ${approval.status} وجود ندارد`,
        currentStatus: approval.status,
      },
      { status: 409 }
    );
  }

  // Booking state machine: WAITING_CUSTOMER_APPROVAL → APPROVED (CUSTOMER role).
  if (!isValidTransition(session.role, booking.status, "APPROVED")) {
    return NextResponse.json(
      {
        error: `انتقال وضعیت مجاز نیست: ${booking.status} → APPROVED برای نقش ${session.role}`,
        currentStatus: booking.status,
        nextStatus: "APPROVED",
      },
      { status: 409 }
    );
  }

  // Sequential writes (D1 has no $transaction).
  // 1. Mark approval as approved.
  const a = await db.customerApproval.update({
    where: { id: approvalId },
    data: {
      status: "CUSTOMER_APPROVED",
      approvedAt: new Date(),
    },
  });

  // 2. Mark the linked finding (if any) as APPROVED.
  if (a.findingId) {
    await db.finding.update({
      where: { id: a.findingId },
      data: { status: "APPROVED" },
    });
  }

  // 3. Transition the booking to APPROVED.
  await db.serviceBooking.update({
    where: { id },
    data: { status: "APPROVED" },
  });

  // 4. Timeline event.
  await db.serviceTimelineEvent.create({
    data: {
      bookingId: id,
      eventType: "customer_approved",
      actor: session.userId,
      metadata: JSON.stringify({ approvalId }),
    },
  });

  return NextResponse.json({ ok: true, approval: a });
}
