import { isPaymentSimulatorRouteEnabled } from "@/lib/payment-simulator-guard";
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { isSafeStoredIrrAmount } from "@/lib/money/financial-read-mask";

// VIP-only local simulator initiation.
// The client identifies a plan; the server owns the amount and purpose.
// Real provider initiation remains disabled until the authoritative lifecycle is wired.
export async function POST(req: Request) {
  if (!isPaymentSimulatorRouteEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (input.purpose !== "vip" || typeof input.planId !== "string" || !input.planId.trim()) {
    return NextResponse.json({ error: "A valid VIP plan is required", code: "VIP_PLAN_REQUIRED" }, { status: 400 });
  }
  if (input.mobile != null && (typeof input.mobile !== "string" || input.mobile.length > 20)) {
    return NextResponse.json({ error: "Invalid mobile value" }, { status: 400 });
  }
  if (input.cardNumber != null && (typeof input.cardNumber !== "string" || input.cardNumber.length > 32)) {
    return NextResponse.json({ error: "Invalid card value" }, { status: 400 });
  }

  const db = await getDbForLib();
  const plan = await db.vipPlan.findUnique({ where: { id: input.planId.trim() } });
  if (!plan || !plan.active) {
    return NextResponse.json({ error: "Plan not found or inactive" }, { status: 404 });
  }
  if (plan.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(plan.priceIrr)) {
    return NextResponse.json({
      error: "قیمت طرح VIP از نظر منشأ و واحد ریال تأیید نشده است",
      code: "VIP_PLAN_PRICE_UNVERIFIED",
    }, { status: 409 });
  }

  const amount = Number(plan.priceIrr);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000) {
    return NextResponse.json({ error: "مبلغ طرح خارج از محدوده مجاز است", code: "VIP_PLAN_AMOUNT_INVALID" }, { status: 409 });
  }

  const code = `PG-${crypto.randomUUID()}`;
  const referenceId = `SIM-${crypto.randomUUID()}`;
  const log = await db.paymentGatewayLog.create({
    data: {
      code,
      userId: session.userId,
      amount,
      currency: "IRR",
      financialUnitStatus: "VERIFIED_IRR",
      gateway: "SHAPARAK_SIM",
      status: "REDIRECTED",
      purpose: "vip",
      targetPlanId: plan.id,
      referenceId,
      cardNumber: input.cardNumber ? maskCard(input.cardNumber) : null,
      mobile: typeof input.mobile === "string" ? input.mobile : null,
      description: `VIP plan: ${plan.name}`,
    },
  });

  return NextResponse.json({
    ok: true,
    code: log.code,
    referenceId,
    amount,
    currency: "IRR",
    purpose: "vip",
    planId: plan.id,
  });
}

function maskCard(card: string): string {
  const digits = card.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `**** **** **** ${digits.slice(-4)}`;
}
