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

  const requestedAmount = Number(amount);
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
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

  if (Number(wallet.balance) < requestedAmount) {
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
  let balanceDeducted = false;
  let withdrawalId: string | null = null;
  let ledgerId: string | null = null;
  let balanceBefore = Number(wallet.balance);

  try {
    // Re-check before mutation, then use a conditional atomic decrement.
    const lockedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    if (!lockedWallet || Number(lockedWallet.balance) < requestedAmount) {
      return NextResponse.json({ error: "موجودی کافی نیست" }, { status: 400 });
    }
    balanceBefore = Number(lockedWallet.balance);

    const deductResult = await db.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: requestedAmount } },
      data: { balance: { decrement: requestedAmount } },
    });
    if (deductResult.count !== 1) {
      return NextResponse.json(
        { error: "موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره تلاش کنید" },
        { status: 409 }
      );
    }
    balanceDeducted = true;

    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    const actualBalanceAfter = updatedWallet
      ? Number(updatedWallet.balance)
      : balanceBefore - requestedAmount;

    const withdrawal = await db.withdrawalRequest.create({
      data: {
        code: `WD-${Math.floor(100000 + Math.random() * 900000)}`,
        walletId: wallet.id,
        amount: requestedAmount,
        method: method || "card",
        cardNumber: cardNumber?.replace(/.(?=.{4})/g, "*"),
        bankName,
        shebaNumber,
        status: "REQUESTED",
      },
    });
    withdrawalId = withdrawal.id;

    const ledger = await db.walletLedger.create({
      data: {
        walletId: wallet.id,
        type: "WITHDRAWAL",
        amount: -requestedAmount,
        balanceBefore,
        balanceAfter: actualBalanceAfter,
        referenceType: "Withdrawal",
        referenceId: withdrawal.id,
        description: `Withdrawal request ${withdrawal.code}`,
      },
    });
    ledgerId = ledger.id;

    // Notifications are best-effort: a notification outage must not make a
    // completed withdrawal look failed and encourage a duplicate retry.
    try {
      await db.notification.create({
        data: {
          userId: session.userId,
          type: "withdrawal_requested",
          title: `درخواست برداشت ${requestedAmount} ثبت شد`,
          body: "درخواست برداشت شما ثبت شد و در انتظار تأیید است.",
          category: "payment",
          link: "technician/earnings",
        },
      });
    } catch (notificationError) {
      console.error("[wallets/withdraw] Notification failed after withdrawal was recorded", {
        withdrawalId: withdrawal.id,
        error: notificationError,
      });
    }

    return NextResponse.json({ withdrawal, newBalance: actualBalanceAfter });
  } catch (e: unknown) {
    // Best-effort compensation for failures before the operation is fully
    // recorded. Never refund while a withdrawal or ledger record still exists:
    // doing so could permit an admin payout without the matching debit.
    let compensationError: unknown = null;
    try {
      if (ledgerId) {
        await db.walletLedger.delete({ where: { id: ledgerId } });
      }
      if (withdrawalId) {
        await db.withdrawalRequest.delete({ where: { id: withdrawalId } });
      }
      if (balanceDeducted) {
        const refund = await db.wallet.updateMany({
          where: { id: wallet.id },
          data: { balance: { increment: requestedAmount } },
        });
        if (refund.count !== 1) throw new Error("Wallet balance compensation did not update exactly one row");
      }
    } catch (rollbackError) {
      compensationError = rollbackError;
    }

    if (compensationError) {
      console.error("[wallets/withdraw] CRITICAL: withdrawal compensation failed", {
        walletId: wallet.id,
        withdrawalId,
        ledgerId,
        error: compensationError,
        originalError: e,
      });
      return NextResponse.json(
        { error: "وضعیت برداشت نیازمند بررسی پشتیبانی است؛ دوباره درخواست برداشت ثبت نکنید" },
        { status: 500 }
      );
    }

    const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
    console.error("[wallets/withdraw] Withdrawal failed and compensation completed", {
      walletId: wallet.id,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
