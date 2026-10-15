import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireBookingParticipant } from "@/lib/care-auth";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;

  // SEC-11 fix: BOLA check before reading timeline events.
  // Without this, any authenticated user could read another user's booking
  // timeline by guessing/enumerating the booking id (cross-tenant disclosure).
  const authError = await requireBookingParticipant(session, id);
  if (authError) return authError;

  const events = await db.serviceTimelineEvent.findMany({ where: { bookingId: id }, orderBy: { timestamp: "asc" } });
  return NextResponse.json(events);
}
