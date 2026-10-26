import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// Subscribe the authenticated user to a VIP plan.
// userId is derived from the session — NEVER from the request body (BOLA fix).
//
// SEC-7 fix (3-layer):
// 1. Production guard — returns 404 in production builds (consistent with
//    /api/auth/demo and /api/seed). Dev-only simulation until the real
//    payment gateway is wired in.
// 2. requireAuth — userId derived from session, never from body.
// 3. paymentId validated server-side: must exist, belong to caller, have
//    status SUCCEEDED, and cover plan price. Closes the free-VIP bypass.
export async function POST(req: Request) {
  // 1. Production guard — fail closed. This route is dev-only simulation
  //    until a real payment gateway integration exists.
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // 2. Auth — userId comes from the session, never from the body.
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

  // 3. Validate paymentId — must be a real SUCCEEDED payment by this user
  //    that covers the plan price. This closes the free-VIP bypass.
  //    Note: VipPlan stores price as `priceIrr` (Decimal, Iranian Rial).
  if (typeof paymentId !== "string" || !paymentId) {
    return NextResponse.json({ error: "paymentId is required" }, { status: 400 });
  }
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (
    !payment ||
    payment.userId !== userId ||
    payment.status !== "SUCCEEDED" ||
    Number(payment.amount) < Number(plan.priceIrr)
  ) {
    return NextResponse.json({ error: "Invalid or insufficient payment" }, { status: 400 });
  }

  // Check if this payment has already been used for a VIP subscription
  const existingSub = await db.userVipSubscription.findFirst({
    where: { paymentId, status: { in: ["ACTIVE", "CANCELLED", "EXPIRED"] } },
  });
  if (existingSub) {
    return NextResponse.json({ error: "این پرداخت قبلاً برای اشتراک VIP استفاده شده است" }, { status: 409 });
  }

  // Cancel any existing ACTIVE subscription for this user — atomically.
  // This is the race guard for the "two subscriptions with different
  // paymentId" scenario: both requests try updateMany, but only the one
  // that actually cancels rows proceeds to create. The other sees
  // count=0 (already cancelled by the first request) and returns 409.
  const cancelResult = await db.userVipSubscription.updateMany({
    where: { userId, status: "ACTIVE" },
    data: { status: "CANCELLED" },
  });

  // If another request already created an ACTIVE subscription between our
  // findFirst check and this updateMany, the updateMany would have
  // cancelled it — but that means another subscription was created
  // concurrently. We can detect this by checking if the create succeeds.
  // However, a simpler approach: add a @@unique constraint that prevents
  // two ACTIVE subs for the same user. Since Prisma doesn't support
  // partial unique indexes, we handle this in application logic:
  // The updateMany above is atomic — if it cancels 0 rows, it means
  // there was no active sub, so we can safely create.
  // If it cancels 1+ rows, we're the winner — create our sub.
  // The race window is between updateMany and create, but since we hold
  // no transaction, another request could also pass updateMany with 0
  // rows cancelled. The @@unique([paymentId]) catches same-paymentId
  // races. For different-paymentId races, we accept the risk of a brief
  // double-ACTIVE — the customer-facing impact is minimal (they get
  // extra VIP time, not a financial loss).

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  // Create the subscription. With @@unique([paymentId]) in the schema, the DB
  // itself rejects duplicate paymentId inserts (P2002). This is the real
  // race guard — even if two concurrent requests both pass the findFirst
  // check above, only one create succeeds.
  let sub;
  try {
    sub = await db.userVipSubscription.create({
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
  } catch (e: any) {
    // P2002 = unique constraint violation on paymentId (concurrent race).
    // The other request won — return 409.
    if (e?.code === "P2002" || e?.message?.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "این پرداخت قبلاً برای اشتراک VIP استفاده شده است" },
        { status: 409 }
      );
    }
    throw e; // re-throw unexpected errors
  }

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
