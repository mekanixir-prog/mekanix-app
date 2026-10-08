// MEKANIX CARE — Extra cost proposal (technician → customer)
//
// Security:
//   - requireAuth (any authenticated user)
//   - requireAssignedTechnician — only the technician assigned to this booking (or ADMIN) may propose extras.
//   - Booking must be in INSPECTING or IN_SERVICE state.
//   - Transition to WAITING_CUSTOMER_APPROVAL is validated via the state machine in care-auth.
//
// Atomicity:
//   - D1 does NOT support db.$transaction; all side effects (Finding create,
//     CustomerApproval create, ServiceBooking status update,
//     ServiceTimelineEvent create, Notification create) run sequentially via
//     db.* directly. If a later write fails, earlier writes stay (acceptable
//     for D1 — true batch transactions are not yet exposed through Prisma).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-helpers";
import {
  requireAssignedTechnician,
  isValidTransition,
} from "@/lib/care-auth";
import { runSequential } from "@/lib/db-sequential";

// Booking states in which a technician may propose an extra cost.
// Any other state means the proposal is out-of-context for the current workflow.
const EXTRA_PROPOSAL_ALLOWED_STATES = ["INSPECTING", "IN_SERVICE"];

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // Authorization: must be the assigned technician (or ADMIN).
  // Replaces the previous role-only check which let ANY technician propose extras
  // on bookings they were not assigned to (BOLA).
  const authz = await requireAssignedTechnician(session, id);
  if (authz) return authz;

  // Parse request body early so we can fail fast on malformed input.
  const body = await req.json();

  // Fetch booking (we need its status + customer userId for the notification).
  const booking = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true, userId: true },
  });
  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  // Gate 1: booking must be in a state that semantically allows proposing extras.
  if (!EXTRA_PROPOSAL_ALLOWED_STATES.includes(booking.status)) {
    return NextResponse.json(
      {
        error: "در وضعیت فعلی سفارش امکان ثبت پیشنهاد هزینه اضافه وجود ندارد",
        currentStatus: booking.status,
        allowedStates: EXTRA_PROPOSAL_ALLOWED_STATES,
      },
      { status: 409 }
    );
  }

  // Gate 2: state-machine validation (role + current status → WAITING_CUSTOMER_APPROVAL).
  if (
    !isValidTransition(session.role, booking.status, "WAITING_CUSTOMER_APPROVAL")
  ) {
    return NextResponse.json(
      {
        error: `انتقال وضعیت مجاز نیست: ${booking.status} → WAITING_CUSTOMER_APPROVAL برای نقش ${session.role}`,
        currentStatus: booking.status,
        nextStatus: "WAITING_CUSTOMER_APPROVAL",
      },
      { status: 409 }
    );
  }

  // All side effects run sequentially (D1 has no $transaction).
  // 1. Optionally create (or reuse) a Finding for this proposal.
  let findingId = body.findingId;
  if (!findingId && body.finding) {
    const f = await db.finding.create({
      data: {
        bookingId: id,
        category: body.finding.category || "general",
        title: body.finding.title,
        description: body.finding.description,
        severity: body.finding.severity || "MEDIUM",
      },
    });
    findingId = f.id;
  }

  // 2. Create the CustomerApproval record (status: PROPOSED).
  const newApproval = await db.customerApproval.create({
    data: {
      bookingId: id,
      findingId: findingId || null,
      proposedItem: body.proposedItem,
      description: body.description || null,
      partName: body.partName || null,
      partBrand: body.partBrand || null,
      partNumber: body.partNumber || null,
      partType: body.partType || "OEM",
      quantity: body.quantity || 1,
      partPrice: body.partPrice || 0,
      laborPrice: body.laborPrice || 0,
      totalPrice:
        (body.partPrice || 0) * (body.quantity || 1) + (body.laborPrice || 0),
      imageUrl: body.imageUrl || null,
      technicianNote: body.technicianNote || null,
      status: "PROPOSED",
    },
  });

  // 3. Transition booking → WAITING_CUSTOMER_APPROVAL.
  await db.serviceBooking.update({
    where: { id },
    data: { status: "WAITING_CUSTOMER_APPROVAL" },
  });

  // 4. Timeline event.
  await db.serviceTimelineEvent.create({
    data: {
      bookingId: id,
      eventType: "extra_proposal",
      actor: session.userId,
      metadata: JSON.stringify({ approvalId: newApproval.id }),
    },
  });

  // 5. Notify the customer.
  await db.notification.create({
    data: {
      userId: booking.userId,
      type: "extra_proposal",
      title: "پیشنهاد هزینه اضافه",
      body: `${body.proposedItem} — ${
        (body.partPrice || 0) * (body.quantity || 1) + (body.laborPrice || 0)
      } تومان`,
      category: "job",
      link: "care-detail",
    },
  });

  return NextResponse.json(newApproval);
}
