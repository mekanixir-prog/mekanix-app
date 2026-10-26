import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// ⚠️ DEV MODE: Amount comes from client in dev mode for testing.
// In production, this route returns 404 — real gateway integration
// must resolve amount from the linked entity (invoice/plan), not from client.

export async function POST(req: Request) {
  // Hard block in production — simulator must not be reachable
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  // Require authentication — userId must come from session, not client
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const body = await req.json();
  const { amount, purpose, description, mobile, cardNumber } = body;

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "مبلغ معتبر الزامی است" }, { status: 400 });
  }

  // Validate amount is reasonable (prevent extreme spoofing)
  if (amount > 100_000_000) { // 100M IRR = ~$200 USD max single payment
    return NextResponse.json({ error: "مبلغ غیرمجاز" }, { status: 400 });
  }

  const code = `PG-${Math.floor(7000 + Math.random() * 2000)}`;
  const referenceId = `SIM-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  const db = await getDbForLib();
  const log = await db.paymentGatewayLog.create({
    data: {
      code,
      userId: session.userId, // server-authoritative — NOT from client
      amount,
      currency: "IRR",
      gateway: "SHAPARAK_SIM",
      status: "REDIRECTED",
      purpose: purpose || "vip",
      referenceId,
      cardNumber: cardNumber ? maskCard(cardNumber) : null,
      mobile: mobile ?? null,
      description: description ?? null,
    },
  });

  // Return the reference; frontend simulates the OTP step then calls /verify
  return NextResponse.json({ ok: true, code: log.code, referenceId, amount });
}

function maskCard(card: string): string {
  const digits = card.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `**** **** **** ${digits.slice(-4)}`;
}
