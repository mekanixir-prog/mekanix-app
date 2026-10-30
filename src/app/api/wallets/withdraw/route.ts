import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { createWithdrawalAtomically } from "@/lib/withdrawal-atomic";

export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "فقط مکانیک‌ها می‌توانند برداشت کنند" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const amount = typeof body.amount === "number" ? body.amount : Number.NaN;
  const method = typeof body.method === "string" && body.method.trim()
    ? body.method.trim()
    : "card";
  const cardNumber = typeof body.cardNumber === "string" ? body.cardNumber : null;
  const bankName = typeof body.bankName === "string" ? body.bankName : null;
  const shebaNumber = typeof body.shebaNumber === "string" ? body.shebaNumber : null;
  const idempotencyKey = req.headers.get("idempotency-key") ||
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");

  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
    return NextResponse.json({ error: "مبلغ نامعتبر است" }, { status: 400 });
  }
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "کلید یکتای درخواست لازم است؛ برای هر درخواست برداشت یک شناسه ثابت ارسال کنید" },
      { status: 400 }
    );
  }
  if (!["card", "wallet", "bank", "cash"].includes(method) ||
      (cardNumber && cardNumber.length > 30) ||
      (bankName && bankName.length > 100) || (shebaNumber && shebaNumber.length > 30)) {
    return NextResponse.json({ error: "اطلاعات حساب بانکی نامعتبر است" }, { status: 400 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 404 });
  }

  const db = await getDbForLib();
  const wallet = await db.wallet.findUnique({
    where: { technicianId: technician.id },
    select: { id: true, balance: true },
  });
  if (!wallet) {
    return NextResponse.json({ error: "کیف پول یافت نشد" }, { status: 404 });
  }

  // A retry with the same key returns the original request and never debits again.
  const existing = await db.withdrawalRequest.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    if (existing.walletId !== wallet.id || Number(existing.amount) !== amount) {
      return NextResponse.json({ error: "کلید درخواست قبلاً برای عملیات دیگری استفاده شده است" }, { status: 409 });
    }
    return NextResponse.json({ withdrawal: existing, newBalance: Number(wallet.balance), idempotent: true });
  }

  const clientId = getClientId(req);
  const rl = await rateLimitAsync(
    `withdraw:${clientId}`,
    RATE_LIMITS.WITHDRAW.max,
    RATE_LIMITS.WITHDRAW.windowMs
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: "درخواست‌های برداشت بیش از حد، بعداً دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  try {
    const created = await createWithdrawalAtomically(db, {
      walletId: wallet.id,
      idempotencyKey,
      amount,
      method,
      cardNumber: cardNumber?.replace(/.(?=.{4})/g, "*") ?? null,
      bankName,
      shebaNumber,
      code: `WD-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      requestedAt: new Date(),
    });

    const withdrawal = await db.withdrawalRequest.findUnique({ where: { idempotencyKey } });
    if (!created && withdrawal) {
      if (withdrawal.walletId !== wallet.id || Number(withdrawal.amount) !== amount) {
        return NextResponse.json({ error: "کلید درخواست قبلاً برای عملیات دیگری استفاده شده است" }, { status: 409 });
      }
      const currentWallet = await db.wallet.findUnique({ where: { id: wallet.id }, select: { balance: true } });
      return NextResponse.json({
        withdrawal,
        newBalance: currentWallet ? Number(currentWallet.balance) : Number(wallet.balance),
        idempotent: true,
      });
    }
    if (!created || !withdrawal) {
      return NextResponse.json({ error: "موجودی کافی نیست یا درخواست هم‌زمان ثبت شده است" }, { status: 400 });
    }

    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id }, select: { balance: true } });
    const newBalance = updatedWallet ? Number(updatedWallet.balance) : Number(wallet.balance) - amount;

    // Notifications are deliberately outside the financial transaction.
    try {
      await db.notification.create({
        data: {
          userId: session.userId,
          type: "withdrawal_requested",
          title: `درخواست برداشت ${amount} ثبت شد`,
          body: "درخواست برداشت شما ثبت شد و در انتظار تأیید است.",
          category: "payment",
          link: "technician/earnings",
        },
      });
    } catch {
      // A notification failure must not turn a committed withdrawal into an apparent failure.
    }

    return NextResponse.json({ withdrawal, newBalance });
  } catch (error) {
    // A concurrent request may win the unique idempotency key. Resolve it as a safe retry.
    const raced = await db.withdrawalRequest.findUnique({ where: { idempotencyKey } }).catch(() => null);
    if (raced && raced.walletId === wallet.id && Number(raced.amount) === amount) {
      const currentWallet = await db.wallet.findUnique({ where: { id: wallet.id }, select: { balance: true } });
      return NextResponse.json({
        withdrawal: raced,
        newBalance: currentWallet ? Number(currentWallet.balance) : Number(wallet.balance),
        idempotent: true,
      });
    }
    const message = error instanceof Error ? error.message : "خطا در پردازش برداشت";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
