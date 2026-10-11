import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id } = await ctx.params;
  const events = await db.serviceTimelineEvent.findMany({ where: { bookingId: id }, orderBy: { timestamp: "asc" } });
  return NextResponse.json(events);
}
