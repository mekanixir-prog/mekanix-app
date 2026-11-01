import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { createWithdrawalAtomically } from "@/lib/withdrawal-atomic";
import { isValidIranianSheba } from "@/lib/iranian-iban";

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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }

  const amount = typeof body.amount === "number" ? body.amount : Number.NaN;
  const method = body.method === undefined
    ? "bank"
    : typeof body.method === "string" ? body.method.trim() : "";
  const bankName = typeof body.bankName === "string" ? body.bankName.trim() : "";
  const rawSheba = typeof body.shebaNumber === "string" ? body.shebaNumber : "";
  const shebaNumber = rawSheba.replace(/\\s+/g, "").toUpperCase();
  const maskedCardNumber = null;
  const idempotencyKey = (req.headers.get("idempotency-key") ||
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "")).trim();

  // Amounts use the same base unit as the earnings UI (USD base units).
  // Enforce the UI's $5 minimum server-side and cap precision to cents.
  const amountInCents = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    amount < 5 ||
    amount > 10_000 ||
    !Number.isSafeInteger(amountInCents) ||
    Math.abs(amount * 100 - amountInCents) > 1e-7
  ) {
    return NextResponse.json({ error: "مبلغ نامعتبر است؛ حداقل برداشت ۵ دلار و دقت حداکثر دو رقم اعشار است" }, { status: 400 });
  }
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "کلید یکتای درخواست لازم است؛ برای هر درخواست برداشت یک شناسه ثابت ارسال کنید" },
      { status: 400 }
    );
  }
  // Until automated card payouts exist, bank/Sheba is the only supported payout rail.
  // The admin workflow can mark a withdrawal PAID only after a valid Sheba transfer.
  if (
    method !== "bank" ||
    !bankName ||
    bankName.length > 100 ||
    !isValidIranianSheba(shebaNumber)
  ) {
    return NextResponse.json({ error: "فقط برداشت بانکی با شبای معتبر و نام بانک قابل ثبت است" }, { status: 400 });
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
    if (existing.walletId !== wallet.id || Number(existing.amount) !== amount ||
        existing.method !== method || existing.cardNumber !== maskedCardNumber ||
        existing.bankName !== bankName || existing.shebaNumber !== shebaNumber) {
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
  if (rl.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  }
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
      cardNumber: maskedCardNumber,
      bankName,
      shebaNumber,
      code: `WD-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
      requestedAt: new Date(),
    });

    const withdrawal = await db.withdrawalRequest.findUnique({ where: { idempotencyKey } });
    if (!created && withdrawal) {
      if (withdrawal.walletId !== wallet.id || Number(withdrawal.amount) !== amount ||
          withdrawal.method !== method || withdrawal.cardNumber !== maskedCardNumber ||
          withdrawal.bankName !== bankName || withdrawal.shebaNumber !== shebaNumber) {
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
    if (raced && raced.walletId === wallet.id && Number(raced.amount) === amount &&
        raced.method === method && raced.cardNumber === maskedCardNumber &&
        raced.bankName === bankName && raced.shebaNumber === shebaNumber) {
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
