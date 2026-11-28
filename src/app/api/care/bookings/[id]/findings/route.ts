import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireBookingParticipant, requireAssignedTechnician } from "@/lib/care-auth";
import { getTechnicianFromSession } from "@/lib/auth";
import { maskFinancialFields } from "@/lib/money/financial-read-mask";
import { CareRecordConflictError, CareRecordIdempotencyConflictError, CareRecordNotFoundError, createCareFindingAtomically } from "@/lib/care-record-atomic";
import { CareRecordValidationError, getCareRecordIdempotency, readCareJsonRequest, validateFindingPayload } from "@/lib/care-record-validation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const authErr = await requireBookingParticipant(session, id);
  if (authErr) return authErr;
  const findings = await db.finding.findMany({ where: { bookingId: id }, include: { approvals: true } });
  return NextResponse.json(findings.map((finding) => ({
    ...finding,
    approvals: finding.approvals.map((approval) => maskFinancialFields(approval, ["partPrice", "laborPrice", "totalPrice"])),
  })));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const authErr = await requireAssignedTechnician(session, id);
  if (authErr) return authErr;

  try {
    const payload = validateFindingPayload(await readCareJsonRequest(req, 48 * 1024));
    const idempotency = await getCareRecordIdempotency(req, "finding", id, payload);
    const technician = session.role === "TECHNICIAN" ? await getTechnicianFromSession(session) : null;
    const created = await createCareFindingAtomically(db, {
      bookingId: id,
      actorRole: session.role === "ADMIN" ? "ADMIN" : "TECHNICIAN",
      actorUserId: session.userId,
      actorTechnicianId: technician?.id ?? null,
      ...idempotency,
      ...payload,
    });
    return NextResponse.json(created);
  } catch (error) {
    if (error instanceof CareRecordValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CareRecordIdempotencyConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof CareRecordNotFoundError) return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
    if (error instanceof CareRecordConflictError) return NextResponse.json({ error: "تخصیص سفارش هم‌زمان تغییر کرده است؛ صفحه را بازخوانی و دوباره تلاش کنید" }, { status: 409 });
    throw error;
  }
}
