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
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey.trim())) {
    return NextResponse.json({ error: "A valid idempotencyKey is required", code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  }
  const idempotencyKey = input.idempotencyKey.trim();
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

  const existingAttempt = await db.paymentGatewayLog.findUnique({ where: { idempotencyKey } });
  if (existingAttempt) {
    if (
      existingAttempt.userId !== session.userId ||
      existingAttempt.purpose !== "vip" ||
      existingAttempt.targetPlanId !== plan.id ||
      !isSafeStoredIrrAmount(existingAttempt.amount) ||
      Number(existingAttempt.amount) <= 0 ||
      Number(existingAttempt.amount) > 100_000_000 ||
      existingAttempt.currency !== "IRR" ||
      existingAttempt.financialUnitStatus !== "VERIFIED_IRR" ||
      existingAttempt.status === "FAILED" ||
      existingAttempt.status === "CANCELLED"
    ) {
      return NextResponse.json({ error: "Idempotency key was already used for a different or closed payment attempt", code: "IDEMPOTENCY_KEY_CONFLICT" }, { status: 409 });
    }
    return initiationResponse(existingAttempt, plan.id);
  }

  const code = `PG-${crypto.randomUUID()}`;
  const referenceId = `SIM-${crypto.randomUUID()}`;
  let log;
  let reused = false;
  try {
    log = await db.paymentGatewayLog.create({
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
      idempotencyKey,
      referenceId,
      cardNumber: input.cardNumber ? maskCard(input.cardNumber) : null,
      mobile: typeof input.mobile === "string" ? input.mobile : null,
      description: `VIP plan: ${plan.name}`,
    },
    });
  } catch (error: any) {
    if (error?.code !== "P2002" && !/unique constraint/i.test(String(error?.message ?? ""))) throw error;
    const racedAttempt = await db.paymentGatewayLog.findUnique({ where: { idempotencyKey } });
    if (
      !racedAttempt ||
      racedAttempt.userId !== session.userId ||
      racedAttempt.purpose !== "vip" ||
      racedAttempt.targetPlanId !== plan.id ||
      !isSafeStoredIrrAmount(racedAttempt.amount) ||
      Number(racedAttempt.amount) <= 0 ||
      Number(racedAttempt.amount) > 100_000_000 ||
      racedAttempt.currency !== "IRR" ||
      racedAttempt.financialUnitStatus !== "VERIFIED_IRR" ||
      racedAttempt.status === "FAILED" ||
      racedAttempt.status === "CANCELLED"
    ) {
      return NextResponse.json({ error: "Idempotency key conflict", code: "IDEMPOTENCY_KEY_CONFLICT" }, { status: 409 });
    }
    log = racedAttempt;
    reused = true;
  }

  return NextResponse.json({ ok: true, code: log.code, referenceId: log.referenceId, amount: Number(log.amount), currency: "IRR", purpose: "vip", planId: plan.id, reused });
}

function initiationResponse(log: { code: string; referenceId: string | null; amount: unknown }, planId: string) {
  return NextResponse.json({
    ok: true,
    code: log.code,
    referenceId: log.referenceId,
    amount: Number(log.amount),
    currency: "IRR",
    purpose: "vip",
    planId,
    reused: true,
  });
}

function maskCard(card: string): string {
  const digits = card.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `**** **** **** ${digits.slice(-4)}`;
}
