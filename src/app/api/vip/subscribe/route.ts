import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { assertIrrInteger } from "@/lib/money/irr";
import { createVipSubscriptionAtomically } from "@/lib/vip-subscription-atomic";

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
  const planAmount = Number(plan.priceIrr);
  try {
    assertIrrInteger(planAmount, "VIP plan price");
  } catch {
    return NextResponse.json({ error: "مبلغ طرح VIP باید ریال صحیح و معتبر باشد" }, { status: 400 });
  }

  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (
    !payment ||
    payment.userId !== userId ||
    payment.status !== "SUCCEEDED" ||
    payment.currency !== "IRR" ||
    !payment.gatewayLogId
  ) {
    return NextResponse.json({ error: "Invalid or insufficient payment" }, { status: 400 });
  }

  const paymentAmount = Number(payment.amount);
  try {
    assertIrrInteger(paymentAmount, "VIP payment amount");
  } catch {
    return NextResponse.json({ error: "مبلغ اشتراک یا پرداخت، ریال صحیح و معتبر نیست" }, { status: 400 });
  }
  if (paymentAmount !== planAmount) {
    return NextResponse.json({ error: "پرداخت باید دقیقاً با مبلغ طرح و با واحد IRR برابر باشد" }, { status: 400 });
  }

  // A SUCCEEDED Payment row alone does not prove this charge was intended for
  // VIP. Bind it to the exact verified gateway attempt and purpose.
  const gatewayLog = await db.paymentGatewayLog.findUnique({
    where: { id: payment.gatewayLogId },
  });
  if (!gatewayLog) {
    return NextResponse.json({ error: "Payment is not a verified VIP payment" }, { status: 400 });
  }
  let gatewayAmount: number;
  try {
    gatewayAmount = Number(gatewayLog.amount);
    assertIrrInteger(gatewayAmount, "VIP gateway amount");
  } catch {
    return NextResponse.json({ error: "مبلغ تلاش درگاه، ریال صحیح و معتبر نیست" }, { status: 400 });
  }
  if (
    gatewayLog.userId !== userId ||
    gatewayLog.status !== "VERIFIED" ||
    gatewayLog.purpose !== "vip" ||
    gatewayLog.paymentId !== payment.id ||
    gatewayLog.currency !== payment.currency ||
    gatewayAmount !== paymentAmount
  ) {
    return NextResponse.json({ error: "Payment is not a verified VIP payment" }, { status: 400 });
  }

  // Fast sequential-reuse check. Concurrent requests can both pass this
  // read, so the unique paymentId index and atomic writer remain authoritative.
  const existingSub = await db.userVipSubscription.findFirst({
    where: { paymentId, status: { in: ["ACTIVE", "CANCELLED", "EXPIRED"] } },
  });
  if (existingSub) {
    return NextResponse.json(
      { error: "این پرداخت قبلاً برای اشتراک VIP استفاده شده است" },
      { status: 409 }
    );
  }

  // Replacing the previous ACTIVE subscription is atomic for both Prisma and
  // D1. A partial unique index enforces one ACTIVE subscription per user and
  // a unique paymentId index prevents reuse of a single payment.
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
  let sub;
  try {
    const subscriptionId = await createVipSubscriptionAtomically(db, {
      userId,
      planId,
      paymentId,
      startedAt,
      expiresAt,
    });
    sub = await db.userVipSubscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (!sub) throw new Error("VIP subscription could not be loaded after atomic creation");
  } catch (e: any) {
    if (e?.code === "P2002" || /unique constraint/i.test(String(e?.message ?? ""))) {
      return NextResponse.json(
        { error: "پرداخت قبلاً استفاده شده یا اشتراک فعال دیگری ثبت شده است" },
        { status: 409 }
      );
    }
    throw e;
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
