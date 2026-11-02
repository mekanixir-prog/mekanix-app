import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { assertIrrInteger } from "@/lib/money/irr";

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

  if (process.env.MEKANIX_VIP_PLAN_PRICES_IRR_VERIFIED !== "true") {
    return NextResponse.json(
      { error: "واحد قیمت طرح‌های VIP هنوز تأیید نشده است", code: "VIP_PRICE_CURRENCY_UNVERIFIED" },
      { status: 409 }
    );
  }

  // 3. Validate paymentId — must be a real SUCCEEDED payment by this user
  //    that covers the plan price. This closes the free-VIP bypass.
  //    Note: VipPlan stores price as `priceIrr` (Decimal, Iranian Rial).
  if (typeof paymentId !== "string" || !paymentId) {
    return NextResponse.json({ error: "paymentId is required" }, { status: 400 });
  }
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.userId !== userId || payment.status !== "SUCCEEDED") {
    return NextResponse.json({ error: "Invalid or insufficient payment" }, { status: 400 });
  }

  const paymentAmount = Number(payment.amount);
  const planAmount = Number(plan.priceIrr);
  try {
    assertIrrInteger(paymentAmount, "VIP payment amount");
    assertIrrInteger(planAmount, "VIP plan price");
  } catch {
    return NextResponse.json({ error: "مبلغ اشتراک یا پرداخت، ریال صحیح و معتبر نیست" }, { status: 400 });
  }
  if (payment.currency !== "IRR" || paymentAmount !== planAmount) {
    return NextResponse.json({ error: "پرداخت باید دقیقاً با مبلغ طرح و با واحد IRR برابر باشد" }, { status: 400 });
  }

  // Replace the user's active subscription atomically. If the unique
  // paymentId or one-ACTIVE-per-user index rejects the create, the preceding
  // cancellation is rolled back with the transaction — the previous ACTIVE
  // subscription can never be lost by a failed replacement attempt.
  let sub;
  try {
    sub = await db.$transaction(async (tx) => {
      const existingSub = await tx.userVipSubscription.findFirst({
        where: { paymentId, status: { in: ["ACTIVE", "CANCELLED", "EXPIRED"] } },
      });
      if (existingSub) return null;

      await tx.userVipSubscription.updateMany({
        where: { userId, status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });

      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
      return tx.userVipSubscription.create({
        data: {
          userId,
          planId,
          status: "ACTIVE",
          startedAt,
          expiresAt,
          paymentId,
        },
        include: { plan: true },
      });
    });
  } catch (e: any) {
    if (e?.code === "P2002" || e?.message?.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "پرداخت قبلاً استفاده شده یا اشتراک فعال دیگری ثبت شده است" },
        { status: 409 }
      );
    }
    throw e;
  }

  if (!sub) {
    return NextResponse.json(
      { error: "این پرداخت قبلاً برای اشتراک VIP استفاده شده است" },
      { status: 409 }
    );
  }

  // Notify user — best-effort, never fail a subscription over a notification.
  try {
    await db.notification.create({
      data: {
        userId,
        type: "vip_activated",
        title: "VIP activated",
        body: `Your ${plan.name} plan is active until ${sub.expiresAt?.toLocaleDateString() ?? "further notice"}`,
        category: "system",
        link: "customer/settings",
      },
    });
  } catch (e) {
    console.error("[vip/subscribe] Failed to create notification (subscription still created):", e);
  }

  return NextResponse.json({ ok: true, subscription: sub });
}
