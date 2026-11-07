// MEKANIX CARE — Booking detail (read-only)
// BOLA-protected via requireBookingParticipant: ADMIN / booking owner / assigned technician.
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireBookingParticipant } from "@/lib/care-auth";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";

// GET /api/care/bookings/[id] — booking details
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // BOLA check FIRST (before fetching sensitive related data) — uses a minimal
  // select internally, so we don't leak package/timeline/findings to unauthorized callers.
  const authError = await requireBookingParticipant(session, id);
  if (authError) return authError;

  const booking = await db.serviceBooking.findUnique({
    where: { id },
    include: {
      package: { include: { items: true } },
      timeline: { orderBy: { timestamp: "asc" } },
      findings: { include: { approvals: true } },
      approvals: true,
      partUsages: true,
      healthReport: true,
      inspection: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  // Get pricing snapshot if exists
  const pricing = booking.pricingSnapshotId
    ? await db.pricingSnapshot.findUnique({
        where: { id: booking.pricingSnapshotId },
      })
    : null;

  const maskedBooking = {
    ...booking,
    package: booking.package ? maskFinancialFields(booking.package, ["basePrice"]) : booking.package,
    approvals: booking.approvals.map((approval) => maskFinancialFields(approval, ["partPrice", "laborPrice", "totalPrice"])),
    partUsages: booking.partUsages.map((part) => maskFinancialFields(part, ["unitPrice", "totalPrice"])),
    findings: booking.findings.map((finding) => ({ ...finding, approvals: finding.approvals.map((approval) => maskFinancialFields(approval, ["partPrice", "laborPrice", "totalPrice"])) })),
  };
  const maskedPricing = pricing ? maskFinancialFields(pricing, ["servicePrice", "visitPrice", "laborPrice", "partsPrice", "discount", "taxTotal", "total"], "currency") : pricing;
  return NextResponse.json({ ...maskedBooking, pricing: maskedPricing });
}
