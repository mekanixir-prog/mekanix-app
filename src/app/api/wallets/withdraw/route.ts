import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";

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

  const db = await getDbForLib();
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
    // 1. Re-check balance + atomic deduct using optimistic concurrency
    //    updateMany with where: { balance: { gte: amount } } ensures:
    //    - If balance was already deducted by a concurrent request, count=0
    //    - If balance is insufficient, count=0
    //    - Only one concurrent request succeeds in deducting
    //    This replaces the previous non-atomic read-then-write pattern.
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

    // 3. Deduct balance — atomic with optimistic concurrency guard.
    //    SEC-9 fix: previously used `data: { balance: balanceAfter }` (a stale
    //    pre-computed SET) which allowed two concurrent withdraw requests to
    //    both pass the `balance >= amount` WHERE check and both SET balance to
    //    the same value (idempotent SET, not a second decrement) — effectively
    //    deducting only once while creating two withdrawal requests.
    //
    //    Now uses Prisma atomic `decrement` operator: the SQL becomes
    //    `UPDATE wallet SET balance = balance - ? WHERE ...`, truly atomic at
    //    the DB level. The WHERE clause `balance: { gte: amount }` prevents
    //    negative balance.
    const deductResult = await db.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (deductResult.count === 0) {
      // Race condition: another withdrawal already deducted the balance
      throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید");
    }

    // Re-read the actual post-decrement balance for the ledger + response.
    // We can't use `balanceAfter` anymore because the atomic decrement may
    // have raced with other transactions — the true balance can only be
    // known by re-reading it.
    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    const actualBalanceAfter = updatedWallet ? Number(updatedWallet.balance) : balanceBefore - amount;

    // 4. Create ledger entry
    await db.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: "WITHDRAWAL",
        amount: -amount,
        balanceBefore,
        balanceAfter: actualBalanceAfter,
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

    return NextResponse.json({ withdrawal, newBalance: actualBalanceAfter });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "خطا در پردازش برداشت" }, { status: 400 });
  }
}
