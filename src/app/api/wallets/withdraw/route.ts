import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { createHash } from "node:crypto";

// MEKANIX — Wallet withdraw with idempotency (fix C4)
//
// CRITICAL: D1 does NOT support Prisma's $transaction. The atomic-reserve
// pattern uses the IdempotencyKey.key @unique constraint as the atomic
// primitive: only one INSERT can succeed for a given key. P2002 (unique
// constraint violation) signals that another request already owns the key.
//
// Flow:
//   1. Validate Idempotency-Key header (required)
//   2. Compute requestHash (hash of body) — prevents payload mutation reuse
//   3. Try: db.idempotencyKey.create({ key, status:"IN_PROGRESS", ... })
//      - Success: we own the key → proceed to withdraw
//      - P2002: key exists → findUnique to read status
//        - COMPLETED + hash match → return cached response (no re-execute)
//        - IN_PROGRESS → 409 (another request is running)
//        - FAILED → 409 (key not reusable)
//        - hash mismatch → 409 (same key, different payload = misuse)
//   4. Execute withdraw (existing B2.2 logic)
//   5. Update idempotencyKey: status="COMPLETED", response=JSON.stringify(result)
//      On failure: status="FAILED" (key not reusable; client must generate new)

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function computeRequestHash(body: unknown): string {
  const json = JSON.stringify(body);
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "فقط مکانیک‌ها می‌توانند برداشت کنند" }, { status: 403 });
  }

  // Idempotency-Key header is REQUIRED for withdraw.
  // Prevents double-charge on client retry (network blip, double-tap).
  const idempotencyKey = req.headers.get("x-idempotency-key") || req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "هدر Idempotency-Key الزامی است" },
      { status: 400 }
    );
  }

  // Rate limit: 3 per hour.
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست معتبر نیست" }, { status: 400 });
  }
  const { amount, method, cardNumber, bankName, shebaNumber } = body;

  if (method !== undefined && method !== "card" && method !== "bank") {
    return NextResponse.json({ error: "روش برداشت نامعتبر است" }, { status: 400 });
  }
  if (cardNumber !== undefined && (typeof cardNumber !== "string" || !/^[0-9\s-]{12,25}$/.test(cardNumber))) {
    return NextResponse.json({ error: "شماره کارت نامعتبر است" }, { status: 400 });
  }
  if (bankName !== undefined && (typeof bankName !== "string" || bankName.length > 100)) {
    return NextResponse.json({ error: "نام بانک نامعتبر است" }, { status: 400 });
  }
  if (shebaNumber !== undefined && (typeof shebaNumber !== "string" || !/^IR[0-9]{24}$/.test(shebaNumber))) {
    return NextResponse.json({ error: "شماره شبا نامعتبر است" }, { status: 400 });
  }

  const requestedAmount = Number(amount);
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
    return NextResponse.json({ error: "مبلغ نامعتبر است" }, { status: 400 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 404 });
  }

  const db = await getDbForLib();

  // ──────────── Atomic reserve: try to INSERT the idempotency key ────────────
  // This is the atomic primitive: key @unique means only one INSERT succeeds.
  const requestHash = computeRequestHash(body);
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
  const scopedKey = `withdraw:${session.userId}:${idempotencyKey}`;

  try {
    await db.idempotencyKey.create({
      data: {
        key: scopedKey,
        status: "IN_PROGRESS",
        requestHash,
        userId: session.userId,
        expiresAt,
      },
    });
    // We own the key. Proceed to withdraw.
  } catch (createError: unknown) {
    // P2002 = unique constraint violation = key already exists.
    const code = (createError as { code?: string })?.code;
    if (code !== "P2002") {
      // Unexpected error — log and fail safe (no withdraw executed).
      console.error("[wallets/withdraw] IdempotencyKey create failed (non-P2002)", {
        userId: session.userId,
        error: createError,
      });
      return NextResponse.json(
        { error: "خطا در ثبت کلید یکتایی؛ دوباره با کلید جدید تلاش کنید" },
        { status: 500 }
      );
    }

    // P2002: key exists. findUnique to read status.
    const existing = await db.idempotencyKey.findUnique({ where: { key: scopedKey } });
    if (!existing) {
      // Should not happen (P2002 means row exists). Race edge case.
      return NextResponse.json(
        { error: "خطای هم‌زمانی؛ دوباره تلاش کنید" },
        { status: 409 }
      );
    }

    // Expired? Treat as if it doesn't exist — but we cannot reuse the key
    // (another request might be mid-flight). Tell client to use a new key.
    if (existing.expiresAt.getTime() < Date.now()) {
      return NextResponse.json(
        { error: "کلید یکتایی منقضی شده؛ کلید جدید تولید کنید" },
        { status: 410 }
      );
    }

    // Hash mismatch = same key, different payload = misuse.
    if (existing.requestHash !== requestHash) {
      return NextResponse.json(
        { error: "کلید یکتایی قبلاً با محتوای متفاوت استفاده شده" },
        { status: 409 }
      );
    }

    if (existing.status === "COMPLETED" && existing.response) {
      // Return cached response — this is the idempotent replay.
      const cached = JSON.parse(existing.response);
      return NextResponse.json(cached, { status: 200 });
    }

    if (existing.status === "IN_PROGRESS") {
      // Another request is mid-flight. Client should retry after a delay.
      return NextResponse.json(
        { error: "درخواست قبلی در حال اجرا است؛ کمی بعد تلاش کنید" },
        { status: 409 }
      );
    }

    if (existing.status === "FAILED") {
      // Previous attempt failed. Key is not reusable — client must use new key.
      return NextResponse.json(
        { error: "درخواست قبلی با این کلید ناموفق بوده؛ کلید جدید تولید کنید" },
        { status: 409 }
      );
    }

    // Unknown status — fail safe.
    return NextResponse.json(
      { error: "وضعیت کلید یکتایی نامشخص" },
      { status: 409 }
    );
  }

  // ──────────── We own the key. Execute the withdraw. ────────────
  const wallet = await db.wallet.findUnique({ where: { technicianId: technician.id } });
  if (!wallet) {
    await markIdempotencyFailed(db, scopedKey);
    return NextResponse.json({ error: "کیف پول یافت نشد" }, { status: 404 });
  }

  if (Number(wallet.balance) < requestedAmount) {
    await markIdempotencyFailed(db, scopedKey);
    return NextResponse.json({ error: "موجودی کافی نیست" }, { status: 400 });
  }

  let balanceDeducted = false;
  let withdrawalId: string | null = null;
  let ledgerId: string | null = null;
  let balanceBefore = Number(wallet.balance);

  try {
    const lockedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    if (!lockedWallet || Number(lockedWallet.balance) < requestedAmount) {
      await markIdempotencyFailed(db, scopedKey);
      return NextResponse.json({ error: "موجودی کافی نیست" }, { status: 400 });
    }
    balanceBefore = Number(lockedWallet.balance);

    const deductResult = await db.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: requestedAmount } },
      data: { balance: { decrement: requestedAmount } },
    });
    if (deductResult.count !== 1) {
      await markIdempotencyFailed(db, scopedKey);
      return NextResponse.json(
        { error: "موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره با کلید جدید تلاش کنید" },
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
        method: typeof method === "string" ? method : "card",
        cardNumber: typeof cardNumber === "string" ? cardNumber.replace(/.(?=.{4})/g, "*") : undefined,
        bankName: typeof bankName === "string" ? bankName : undefined,
        shebaNumber: typeof shebaNumber === "string" ? shebaNumber : undefined,
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

    // Notifications are best-effort.
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

    const successResponse = { withdrawal, newBalance: actualBalanceAfter };

    // Mark idempotency key as COMPLETED with the cached response.
    await db.idempotencyKey.updateMany({
      where: { key: scopedKey, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        response: JSON.stringify(successResponse),
      },
    });

    return NextResponse.json(successResponse);
  } catch (e: unknown) {
    // Compensation (same as before B2.2 fix).
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
      // Mark idempotency as FAILED (key not reusable).
      await markIdempotencyFailed(db, scopedKey);
      return NextResponse.json(
        { error: "وضعیت برداشت نیازمند بررسی پشتیبانی است؛ دوباره درخواست برداشت ثبت نکنید" },
        { status: 500 }
      );
    }

    // Compensation succeeded — the operation effectively did not happen.
    // Mark idempotency as FAILED so the client knows to use a new key.
    await markIdempotencyFailed(db, scopedKey);

    const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
    console.error("[wallets/withdraw] Withdrawal failed and compensation completed", {
      walletId: wallet.id,
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Helper: mark idempotency key as FAILED (not reusable).
// Best-effort: if this fails, the key stays IN_PROGRESS and the client
// will get a 409 on retry, prompting them to generate a new key.
async function markIdempotencyFailed(db: Awaited<ReturnType<typeof getDbForLib>>, scopedKey: string) {
  try {
    await db.idempotencyKey.updateMany({
      where: { key: scopedKey, status: "IN_PROGRESS" },
      data: { status: "FAILED" },
    });
  } catch {
    // Best-effort — logged but not surfaced to client.
  }
}
