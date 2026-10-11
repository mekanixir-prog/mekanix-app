import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Subscribe the authenticated user to a VIP plan.
// userId is derived from the session — NEVER from the request body (BOLA fix).
// In production: this would go through the payment gateway first.
// Here: we simulate success (the gateway is separate). Once payment verified,
// we activate the subscription with startedAt=now and expiresAt=now+durationDays.
//
// SECURITY: Previously this endpoint had NO authentication and trusted a
// client-supplied `userId` — any caller could subscribe any user to a VIP
// plan. Now requires auth + uses session.userId (server-authoritative).
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { planId, paymentId } = body;
  const userId = session.userId; // server-authoritative — NOT from body
  if (typeof planId !== "string" || !planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  const db = await getDbForLib();

  const plan = await db.vipPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) {
    return NextResponse.json({ error: "Plan not found or inactive" }, { status: 404 });
  }

  // Cancel any existing ACTIVE subscription for this user
  await db.userVipSubscription.updateMany({
    where: { userId, status: "ACTIVE" },
    data: { status: "CANCELLED" },
  });

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  const sub = await db.userVipSubscription.create({
    data: {
      userId,
      planId,
      status: "ACTIVE",
      startedAt,
      expiresAt,
      paymentId: paymentId ?? null,
    },
    include: { plan: true },
  });

  // Notify user — best-effort, never fail a subscription over a notification.
  try {
    await db.notification.create({
      data: {
        userId,
        type: "vip_activated",
        title: "VIP activated",
        body: `Your ${plan.name} plan is active until ${expiresAt.toLocaleDateString()}`,
        category: "system",
        link: "customer/settings",
      },
    });
  } catch (e) {
    console.error("[vip/subscribe] Failed to create notification (subscription still created):", e);
  }

  return NextResponse.json({ ok: true, subscription: sub });
}
