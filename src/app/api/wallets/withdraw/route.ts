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

  // Rate limit: 3 per hour — uses the shared D1-backed counter across Worker isolates.
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
  // B2.2 fix: the atomic balance decrement now happens BEFORE the
  // WithdrawalRequest.create. This ensures no orphaned WithdrawalRequest
  // can exist in the DB without a corresponding balance deduction.
  //
  // Before B2.2: WithdrawalRequest was created FIRST, then balance was
  // decremented. If the decrement returned count=0 (race loser in concurrent
  // withdraw scenario), the route threw and returned 400, but the
  // WithdrawalRequest row remained in DB with status=REQUESTED. An admin
  // could later approve this orphaned request, causing a payout without
  // a corresponding balance deduction.
  //
  // After B2.2: the atomic decrement happens first. If it fails (count=0),
  // we return 400 immediately — no WithdrawalRequest exists. If it succeeds,
  // the balance IS deducted, and we then create the WithdrawalRequest,
  // ledger, and notification. Even if a later step fails, the balance is
  // deducted but no request exists — a recoverable state (admin can
  // reconcile) rather than an unrecoverable one (payout without deduction).
  try {
    // 1. Re-check balance (early bail before any write).
    const lockedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    if (!lockedWallet || Number(lockedWallet.balance) < amount) {
      throw new Error("موجودی کافی نیست");
    }
    const balanceBefore = Number(lockedWallet.balance);

    // 2. Atomic balance decrement — MUST happen before WithdrawalRequest.create.
    //    SEC-9 fix: uses Prisma atomic `decrement` (SQL: SET balance = balance - ?)
    //    with WHERE `balance >= amount` to prevent negative balance.
    //    If count===0, the race was lost — return 400, NO WithdrawalRequest created.
    const deductResult = await db.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (deductResult.count === 0) {
      // Race condition: another withdrawal already deducted the balance.
      // No WithdrawalRequest created — clean failure.
      throw new Error("موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید");
    }

    // 3. Re-read the actual post-decrement balance for the ledger + response.
    //    We can't use a pre-computed balanceAfter because the atomic decrement
    //    may have raced with other transactions.
    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    const actualBalanceAfter = updatedWallet ? Number(updatedWallet.balance) : balanceBefore - amount;

    // 4. NOW create the WithdrawalRequest — balance is already deducted,
    //    so even if this step fails, no orphaned-request payout can happen.
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

    // 5. Create ledger entry with the ACTUAL post-decrement balance.
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

    // 6. Create notification
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
