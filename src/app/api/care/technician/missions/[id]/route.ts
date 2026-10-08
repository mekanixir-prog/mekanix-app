// MEKANIX CARE — Mission detail + status update (technician-facing)
// BOLA-protected via @/lib/care-auth helpers.
//
// GET    : ADMIN | booking customer | assigned technician
// PATCH  : ADMIN | assigned technician (state-machine validated, optimistic concurrency)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-helpers";
import {
  requireBookingParticipant,
  requireAssignedTechnician,
  validateTransition,
} from "@/lib/care-auth";
import { runSequential } from "@/lib/db-sequential";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // BOLA: any participant (ADMIN / booking owner / assigned technician) may read.
  const authError = await requireBookingParticipant(session, id);
  if (authError) return authError;

  const mission = await db.serviceBooking.findUnique({
    where: { id },
    include: {
      package: { include: { items: true } },
      timeline: { orderBy: { timestamp: "asc" } },
      findings: { include: { approvals: true } },
      partUsages: true,
      inspection: true,
      healthReport: true,
    },
  });
  if (!mission) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  return NextResponse.json(mission);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // BOLA + role: only ADMIN or the assigned technician may update mission status.
  const authError = await requireAssignedTechnician(session, id);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const { status } = body as { status?: unknown };
  if (!status || typeof status !== "string") {
    return NextResponse.json({ error: "فیلد status الزامی است" }, { status: 400 });
  }

  // Fetch current status (minimal select) for state-machine validation + optimistic concurrency.
  const existing = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  // State machine validation (returns NextResponse(409) if invalid, null if OK).
  const transitionError = validateTransition(session.role, existing.status, status);
  if (transitionError) return transitionError;

  // Optimistic concurrency: only update if status hasn't changed since we read it.
  // If count === 0, another request beat us to it → 409 Conflict.
  // (D1 has no $transaction; the updateMany + timeline create are sequential.)
  try {
    const result = await db.serviceBooking.updateMany({
      where: { id, status: existing.status },
      data: { status },
    });
    if (result.count === 0) {
      // Status changed concurrently — abort.
      throw new Error("__CONCURRENT_STATUS_CHANGE__");
    }
    await db.serviceTimelineEvent.create({
      data: {
        bookingId: id,
        eventType: status.toLowerCase(),
        actor: session.userId,
      },
    });
    const updated = await db.serviceBooking.findUnique({ where: { id } });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof Error && err.message === "__CONCURRENT_STATUS_CHANGE__") {
      return NextResponse.json(
        {
          error:
            "وضعیت سفارش همگام نیست — توسط درخواست دیگری تغییر یافته. لطفاً صفحه را بازخوانی و دوباره تلاش کنید.",
        },
        { status: 409 }
      );
    }
    // Re-throw unexpected errors to be handled by Next.js error boundary.
    throw err;
  }
}
