import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { createWithdrawalAtomically } from "@/lib/withdrawal-atomic";
import { isValidIranianSheba } from "@/lib/iranian-iban";
import { getApprovedIrrWithdrawalPolicy, isValidIrrWithdrawalAmount } from "@/lib/money/withdrawal-policy";

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
  const production = process.env.NODE_ENV === "production";
  const withdrawalPolicy = production ? getApprovedIrrWithdrawalPolicy() : null;
  if (production && !withdrawalPolicy) {
    return NextResponse.json(
      { error: "سیاست حداقل و حداکثر برداشت ریالی هنوز تصویب و پیکربندی نشده است", code: "IRR_WITHDRAWAL_POLICY_UNAPPROVED" },
      { status: 503 },
    );
  }
  // The admin settlement path can only mark a withdrawal PAID after a real
  // bank transfer with a valid Iranian Sheba. Do not reserve funds for
  // unsupported card, wallet, or cash destinations.
  const method = typeof body.method === "string" ? body.method.trim() : "";
  const bankName = typeof body.bankName === "string" ? body.bankName.trim() : null;
  const shebaNumber = typeof body.shebaNumber === "string"
    ? body.shebaNumber.replace(/\s+/g, "").toUpperCase()
    : null;
  const maskedCardNumber = null;
  const idempotencyKey = (req.headers.get("idempotency-key") ||
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "")).trim();

  const validAmount = production
    ? isValidIrrWithdrawalAmount(amount, withdrawalPolicy!)
    : Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000;
  if (!validAmount) {
    return NextResponse.json(
      { error: production
        ? "مبلغ باید عدد صحیح ریالی و در محدوده مصوب برداشت باشد"
        : "مبلغ باید عدد صحیح مثبت باشد" },
      { status: 400 },
    );
  }
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "کلید یکتای درخواست لازم است؛ برای هر درخواست برداشت یک شناسه ثابت ارسال کنید" },
      { status: 400 }
    );
  }
  if (
    method !== "bank" ||
    !isValidIranianSheba(shebaNumber) ||
    (bankName !== null && bankName.length > 100)
  ) {
    return NextResponse.json(
      { error: "فعلاً فقط برداشت بانکی با شبای معتبر امکان‌پذیر است" },
      { status: 400 },
    );
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
    // Never expose raw database/ORM errors to clients. The original failure
    // remains available in server logs for operator diagnosis.
    console.error(
      "[wallet-withdrawal] atomic processing failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      {
        error: "پردازش درخواست برداشت موقتاً ناموفق بود؛ وضعیت درخواست را بررسی و در صورت نیاز با همان شناسه پیگیری دوباره تلاش کنید",
        code: "WITHDRAWAL_PROCESSING_FAILED",
      },
      { status: 503 },
    );
  }
}
