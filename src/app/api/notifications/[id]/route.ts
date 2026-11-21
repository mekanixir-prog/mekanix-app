import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireNotificationOwner } from "@/lib/auth";

// PATCH /api/notifications/[id]
// Marks a single notification as read. Owner-only (BOLA).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const ownership = await requireNotificationOwner(session, id);
  if (ownership) return ownership;

  const db = await getDbForLib();
  const n = await db.notification.update({ where: { id }, data: { read: true } });
  return NextResponse.json(n);
}
