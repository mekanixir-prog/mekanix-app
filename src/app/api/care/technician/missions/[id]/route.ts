// MEKANIX CARE — Mission detail + status update (technician-facing)
// BOLA-protected via @/lib/care-auth helpers.
//
// GET    : ADMIN | booking customer | assigned technician
// PATCH  : ADMIN | assigned technician (state-machine validated, optimistic concurrency)
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import {
  requireBookingParticipant,
  validateTransition,
} from "@/lib/care-auth";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
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
  return NextResponse.json({
    ...mission,
    package: mission.package ? maskFinancialFields(mission.package, ["basePrice"]) : mission.package,
    findings: mission.findings.map((finding) => ({
      ...finding,
      approvals: finding.approvals.map((approval) => maskFinancialFields(approval, ["partPrice", "laborPrice", "totalPrice"])),
    })),
    partUsages: mission.partUsages.map((part) => maskFinancialFields(part, ["unitPrice", "totalPrice"])),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  if (session.role !== "TECHNICIAN" && session.role !== "ADMIN") {
    return NextResponse.json({ error: "این عملیات فقط برای مکانیک یا مدیر مجاز است" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const db = await getDbForLib();

  // Resolve the authenticated technician once and carry that identity into
  // the conditional write. The assignment may change after the initial read.
  let actorTechnicianId: string | null = null;
  if (session.role === "TECHNICIAN") {
    const technician = await getTechnicianFromSession(session);
    if (!technician) {
      return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
    }
    actorTechnicianId = technician.id;
  }

  const existing = await db.serviceBooking.findUnique({
    where: { id },
    select: { id: true, status: true, technicianId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  if (actorTechnicianId && existing.technicianId !== actorTechnicianId) {
    return NextResponse.json({ error: "شما به این سفارش اختصاص ندارید" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  const { status } = body as { status?: unknown };
  if (!status || typeof status !== "string") {
    return NextResponse.json({ error: "فیلد status الزامی است" }, { status: 400 });
  }

  const transitionError = validateTransition(session.role, existing.status, status);
  if (transitionError) return transitionError;

  // Include the authenticated technician's profile ID in the compare-and-set.
  // If assignment changes after the read above, updateMany affects zero rows.
  try {
    const result = await db.serviceBooking.updateMany({
      where: {
        id,
        status: existing.status,
        ...(actorTechnicianId ? { technicianId: actorTechnicianId } : {}),
      },
      data: { status },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "وضعیت یا تخصیص سفارش هم‌زمان تغییر کرده است؛ صفحه را بازخوانی و دوباره تلاش کنید" },
        { status: 409 }
      );
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
    throw err;
  }
}
