// MEKANIX — Unified Service detail endpoint.
//
// GET /api/services/[id]
//
// Returns a single service — looks up by ID across BOTH underlying models
// (ServiceBooking first, then Job). The `source` field on the response tells
// the client which underlying model the record came from.
//
// BOLA protection:
//   - For bookings, ownership is `booking.userId === session.userId`.
//   - For jobs, ownership is `job.request.customer.userId === session.userId`.
//   - The unified facade already normalises both into `service.customerId`,
//     so we can do a single comparison here.
//   - ADMIN bypasses the ownership check.
//   - TECHNICIAN is allowed to view services they're assigned to
//     (`service.technicianId === session.userId` is checked via the technician
//     record — but for simplicity we accept any technician here since the
//     detail endpoint is read-only and the underlying `requireJobParticipant`
//     / `requireBookingParticipant` are the canonical write-side guards).
//
// This endpoint is ADDITIVE — existing /api/jobs/[id] and
// /api/care/bookings/[id] routes continue to work unchanged.

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-helpers";
import { getServiceById } from "@/lib/service-unified";
import { getTechnicianFromSession } from "@/lib/auth";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;
  const service = await getServiceById(id);

  if (!service) {
    return NextResponse.json(
      { error: "سرویس یافت نشد" },
      { status: 404 }
    );
  }

  // BOLA: ADMIN bypasses. Otherwise the caller must be either:
  //   - the owning customer (service.customerId === session.userId), or
  //   - the assigned technician (resolved via the Technician record linked
  //     to this User, since service.technicianId points to Technician.id
  //     on both underlying models — not to User.id).
  if (session.role !== "ADMIN") {
    const isOwner = service.customerId === session.userId;

    let isAssignedTech = false;
    if (service.technicianId) {
      const technician = await getTechnicianFromSession(session);
      if (technician && technician.id === service.technicianId) {
        isAssignedTech = true;
      }
    }

    if (!isOwner && !isAssignedTech) {
      return NextResponse.json(
        { error: "دسترسی مجاز نیست" },
        { status: 403 }
      );
    }
  }

  return NextResponse.json(service);
}
