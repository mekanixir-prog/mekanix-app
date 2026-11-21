import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { wantsLite, liteResponse } from "@/lib/lite-response";

// GET: list the authenticated user's notifications.
// userId is derived from the session — the `userId` query param is IGNORED (BOLA protection).
// Pass ?lite=true to receive a compressed response (id/status/code/ts only) for weak networks.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const db = await getDbForLib();
  const list = await db.notification.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const lite = wantsLite(req);
  return NextResponse.json(liteResponse(list, lite));
}

// PATCH: mark all of the authenticated user's notifications as read.
export async function PATCH(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const db = await getDbForLib();
  await db.notification.updateMany({
    where: { userId: session.userId },
    data: { read: true },
  });
  return NextResponse.json({ ok: true });
}
