import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { runSequential } from "@/lib/db-sequential";

export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "فقط مکانیک‌ها می‌توانند برداشت کنند" }, { status: 403 });
  }

  // Rate limit: 3 per hour — uses Redis-backed `rateLimitAsync()` so the
  // withdrawal budget is shared across instances when REDIS_URL is set.
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

  const body = await req.json();
  const { amount, method, cardNumber, bankName, shebaNumber } = body;

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "مبلغ نامعتبر است" }, { status: 400 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 404 });
  }

  const wallet = await db.wallet.findUnique({ where: { technicianId: technician.id } });
  if (!wallet) {
    return NextResponse.json({ error: "کیف پول یافت نشد" }, { status: 404 });
  }

  if (Number(wallet.balance) < amount) {
    return NextResponse.json({ error: "موجودی کافی نیست" }, { status: 400 });
  }

  // Sequential writes (D1-compatible: no $transaction wrapper).
  // If an error occurs midway, earlier writes stay — acceptable for D1
  // (D1 batch() would be better but isn't exposed through Prisma yet).
  try {
    // 1. Re-check balance (best-effort race-condition guard; no DB lock in D1)
    const lockedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    if (!lockedWallet || Number(lockedWallet.balance) < amount) {
      throw new Error("موجودی کافی نیست");
    }

    const balanceBefore = Number(lockedWallet.balance);
    const balanceAfter = balanceBefore - amount;

    // 2. Create withdrawal request
    const withdrawal = await db.withdrawalRequest.create({
      data: {
        code: `WD-${Math.floor(100000 + Math.random() * 900000)}`,
        walletId: wallet.id,
        amount,
        method: method || "card",
        cardNumber: cardNumber?.replace(/.(?=.{4})/g, "*"),
        bankName,
        shebaNumber,
        status: "REQUESTED",
      },
    });

    // 3. Deduct balance
    await db.wallet.update({
      where: { id: wallet.id },
      data: { balance: balanceAfter },
    });

    // 4. Create ledger entry
    await db.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: "WITHDRAWAL",
        amount: -amount,
        balanceBefore,
        balanceAfter,
        referenceType: "Withdrawal",
        referenceId: withdrawal.id,
        description: `Withdrawal request ${withdrawal.code}`,
      },
    });

    // 5. Create notification
    await db.notification.create({
      data: {
        userId: session.userId,
        type: "withdrawal_requested",
        title: `درخواست برداشت ${amount} ثبت شد`,
        body: `درخواست برداشت شما ثبت شد و در انتظار تأیید است.`,
        category: "payment",
        link: "technician/earnings",
      },
    });

    return NextResponse.json({ withdrawal, newBalance: balanceAfter });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "خطا در پردازش برداشت" }, { status: 400 });
  }
}
