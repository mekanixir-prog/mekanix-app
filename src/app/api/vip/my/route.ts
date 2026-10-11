import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Get the current active VIP subscription — userId derived from JWT session
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const userId = session.userId; // Server-authoritative — NOT from query param
  const db = await getDbForLib();

  // Expire any active subscriptions past their expiry
  const now = new Date();
  await db.userVipSubscription.updateMany({
    where: { userId, status: "ACTIVE", expiresAt: { not: null, lt: now } },
    data: { status: "EXPIRED" },
  });

  const subscription = await db.userVipSubscription.findFirst({
    where: { userId, status: "ACTIVE" },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ subscription });
}
