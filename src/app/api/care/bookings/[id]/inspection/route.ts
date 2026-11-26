import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireBookingParticipant, requireAssignedTechnician } from "@/lib/care-auth";
import { getTechnicianFromSession } from "@/lib/auth";
import { CareRecordConflictError, CareRecordIdempotencyConflictError, CareRecordNotFoundError, upsertCareInspectionAtomically } from "@/lib/care-record-atomic";
import { CareRecordValidationError, getCareRecordIdempotency, readCareJsonRequest, validateInspectionPayload } from "@/lib/care-record-validation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const authErr = await requireBookingParticipant(session, id);
  if (authErr) return authErr;
  const inspection = await db.inspection.findUnique({ where: { bookingId: id } });
  return NextResponse.json(inspection);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const authErr = await requireAssignedTechnician(session, id);
  if (authErr) return authErr;

  try {
    const payload = validateInspectionPayload(await readCareJsonRequest(req, 64 * 1024));
    const idempotency = await getCareRecordIdempotency(req, "inspection", id, payload);
    const technician = session.role === "TECHNICIAN" ? await getTechnicianFromSession(session) : null;
    const upserted = await upsertCareInspectionAtomically(db, {
      bookingId: id,
      actorRole: session.role === "ADMIN" ? "ADMIN" : "TECHNICIAN",
      actorUserId: session.userId,
      actorTechnicianId: technician?.id ?? null,
      ...idempotency,
      ...payload,
    });
    return NextResponse.json(upserted);
  } catch (error) {
    if (error instanceof CareRecordValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CareRecordIdempotencyConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof CareRecordNotFoundError) return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
    if (error instanceof CareRecordConflictError) return NextResponse.json({ error: "تخصیص سفارش هم‌زمان تغییر کرده است؛ صفحه را بازخوانی و دوباره تلاش کنید" }, { status: 409 });
    throw error;
  }
}
