import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getUsdToIrrRate } from "@/lib/exchange-rate";

// Simulator-only checkout accepts canonical USD amounts. The gateway log stores
// both the locked USD order value and the converted Rial amount.
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const amountUsd = typeof body.amount === "number" ? body.amount : Number.NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100_000) {
    return NextResponse.json({ error: "مبلغ دلاری نامعتبر است" }, { status: 400 });
  }

  const purpose = typeof body.purpose === "string" &&
    ["vip", "prepay", "invoice", "wallet_topup"].includes(body.purpose)
    ? body.purpose
    : "vip";
  const exchange = await getUsdToIrrRate();
  const amountIrr = Math.round(amountUsd * exchange.rate);
  if (!Number.isSafeInteger(amountIrr) || amountIrr <= 0) {
    return NextResponse.json({ error: "مبلغ تبدیل‌شده برای درگاه معتبر نیست" }, { status: 400 });
  }

  const code = `PG-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  const referenceId = `SIM-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const db = await getDbForLib();
  const log = await db.paymentGatewayLog.create({
    data: {
      code,
      userId: session.userId,
      amount: amountIrr,
      currency: "IRR",
      baseAmountUsd: amountUsd,
      exchangeRate: exchange.rate,
      gateway: "SHAPARAK_SIM",
      status: "REDIRECTED",
      purpose,
      referenceId,
      cardNumber: typeof body.cardNumber === "string" ? maskCard(body.cardNumber) : null,
      mobile: typeof body.mobile === "string" ? body.mobile : null,
      description: typeof body.description === "string" ? body.description.slice(0, 300) : null,
    },
  });

  return NextResponse.json({
    ok: true,
    code: log.code,
    referenceId,
    amount: amountUsd,
    amountIrr,
    exchangeRate: exchange.rate,
  });
}

function maskCard(card: string): string {
  const digits = card.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `**** **** **** ${digits.slice(-4)}`;
}
