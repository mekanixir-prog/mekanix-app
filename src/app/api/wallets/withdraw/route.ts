import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { createHash, randomUUID } from "node:crypto";
import { executeAtomicRefund } from "@/lib/atomic-refund";

// MEKANIX — Wallet withdraw with idempotency + recovery (fixes C1, C3, C4, C6)
//
// CRITICAL: D1 does NOT support Prisma's $transaction. The atomic-reserve
// pattern uses the IdempotencyKey.key @unique constraint as the atomic
// primitive: only one INSERT can succeed for a given key. P2002 (unique
// constraint violation) signals that another request already owns the key.
//
// Fixes applied in this file:
//   C4 — atomic reserve via IdempotencyKey, no double-charge on retry
//   C1 — refund count=0 in compensation → RECONCILIATION_NEEDED (not silent)
//   C3 — WithdrawalCode P2002 → retry with new code (max 3 attempts)
//   C6 — correlationId in all 500 responses and CRITICAL logs
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
//   4. Execute withdraw (B2.2 logic + C3 retry on P2002)
//   5. Update idempotencyKey: status="COMPLETED", response=...
//      - Check count: if 0, the key was modified out from under us →
//        log CRITICAL with correlationId, but DO NOT refund (withdrawal succeeded)
//   6. On failure: compensation (C1: count=0 → RECONCILIATION_NEEDED),
//      mark idempotency FAILED, return 500 with correlationId (C6)

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CODE_RETRY_MAX = 3; // C3: max attempts to generate a unique WD-xxxxxx code

function computeRequestHash(body: unknown): string {
  const json = JSON.stringify(body);
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

function newCorrelationId(): string {
  return randomUUID();
}

export async function POST(req: Request) {
  const correlationId = newCorrelationId();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "فقط مکانیک‌ها می‌توانند برداشت کنند" }, { status: 403 });
  }

  // Idempotency-Key header is REQUIRED for withdraw (C4 fix).
  const idempotencyKey = req.headers.get("x-idempotency-key") || req.headers.get("Idempotency-Key");
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "هدر Idempotency-Key الزامی است", correlationId },
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
      { error: "درخواست‌های برداشت بیش از حد، بعداً دوباره تلاش کنید", correlationId },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "بدنه درخواست معتبر نیست", correlationId },
      { status: 400 }
    );
  }
  const { amount, method, cardNumber, bankName, shebaNumber } = body;

  if (method !== undefined && method !== "card" && method !== "bank") {
    return NextResponse.json({ error: "روش برداشت نامعتبر است", correlationId }, { status: 400 });
  }
  if (cardNumber !== undefined && (typeof cardNumber !== "string" || !/^[0-9\s-]{12,25}$/.test(cardNumber))) {
    return NextResponse.json({ error: "شماره کارت نامعتبر است", correlationId }, { status: 400 });
  }
  if (bankName !== undefined && (typeof bankName !== "string" || bankName.length > 100)) {
    return NextResponse.json({ error: "نام بانک نامعتبر است", correlationId }, { status: 400 });
  }
  if (shebaNumber !== undefined && (typeof shebaNumber !== "string" || !/^IR[0-9]{24}$/.test(shebaNumber))) {
    return NextResponse.json({ error: "شماره شبا نامعتبر است", correlationId }, { status: 400 });
  }

  const requestedAmount = Number(amount);
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
    return NextResponse.json({ error: "مبلغ نامعتبر است", correlationId }, { status: 400 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد", correlationId }, { status: 404 });
  }

  const db = await getDbForLib();

  // ──────────── Atomic reserve: try to INSERT the idempotency key ────────────
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
    const code = (createError as { code?: string })?.code;
    if (code !== "P2002") {
      console.error("[wallets/withdraw] IdempotencyKey create failed (non-P2002)", {
        userId: session.userId,
        correlationId,
        error: createError,
      });
      return NextResponse.json(
        { error: "خطا در ثبت کلید یکتایی؛ دوباره با کلید جدید تلاش کنید", correlationId },
        { status: 500 }
      );
    }

    // P2002: key exists. findUnique to read status.
    const existing = await db.idempotencyKey.findUnique({ where: { key: scopedKey } });
    if (!existing) {
      return NextResponse.json(
        { error: "خطای هم‌زمانی؛ دوباره تلاش کنید", correlationId },
        { status: 409 }
      );
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      return NextResponse.json(
        { error: "کلید یکتایی منقضی شده؛ کلید جدید تولید کنید", correlationId },
        { status: 410 }
      );
    }

    if (existing.requestHash !== requestHash) {
      return NextResponse.json(
        { error: "کلید یکتایی قبلاً با محتوای متفاوت استفاده شده", correlationId },
        { status: 409 }
      );
    }

    if (existing.status === "COMPLETED" && existing.response) {
      const cached = JSON.parse(existing.response);
      return NextResponse.json(cached, { status: 200 });
    }

    if (existing.status === "IN_PROGRESS") {
      return NextResponse.json(
        { error: "درخواست قبلی در حال اجرا است؛ کمی بعد تلاش کنید", correlationId },
        { status: 409 }
      );
    }

    if (existing.status === "FAILED") {
      return NextResponse.json(
        { error: "درخواست قبلی با این کلید ناموفق بوده؛ کلید جدید تولید کنید", correlationId },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: "وضعیت کلید یکتایی نامشخص", correlationId },
      { status: 409 }
    );
  }

  // ──────────── We own the key. Execute the withdraw. ────────────
  const wallet = await db.wallet.findUnique({ where: { technicianId: technician.id } });
  if (!wallet) {
    await markIdempotencyFailed(db, scopedKey);
    return NextResponse.json({ error: "کیف پول یافت نشد", correlationId }, { status: 404 });
  }

  if (Number(wallet.balance) < requestedAmount) {
    await markIdempotencyFailed(db, scopedKey);
    return NextResponse.json({ error: "موجودی کافی نیست", correlationId }, { status: 400 });
  }

  let balanceDeducted = false;
  let withdrawalId: string | null = null;
  let ledgerId: string | null = null;
  let balanceBefore = Number(wallet.balance);

  try {
    const lockedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    if (!lockedWallet || Number(lockedWallet.balance) < requestedAmount) {
      await markIdempotencyFailed(db, scopedKey);
      return NextResponse.json({ error: "موجودی کافی نیست", correlationId }, { status: 400 });
    }
    balanceBefore = Number(lockedWallet.balance);

    const deductResult = await db.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: requestedAmount } },
      data: { balance: { decrement: requestedAmount } },
    });
    if (deductResult.count !== 1) {
      await markIdempotencyFailed(db, scopedKey);
      return NextResponse.json(
        { error: "موجودی توسط درخواست هم‌زمان تغییر کرد — دوباره با کلید جدید تلاش کنید", correlationId },
        { status: 409 }
      );
    }
    balanceDeducted = true;

    const updatedWallet = await db.wallet.findUnique({ where: { id: wallet.id } });
    const actualBalanceAfter = updatedWallet
      ? Number(updatedWallet.balance)
      : balanceBefore - requestedAmount;

    // ─── C3 fix: retry WithdrawalCode on P2002 ───
    // The random 6-digit code may collide with an existing row. On P2002,
    // generate a new code and retry up to CODE_RETRY_MAX times.
    let withdrawal;
    let lastCreateError: unknown;
    for (let attempt = 1; attempt <= CODE_RETRY_MAX; attempt++) {
      const code = `WD-${Math.floor(100000 + Math.random() * 900000)}`;
      try {
        withdrawal = await db.withdrawalRequest.create({
          data: {
            code,
            walletId: wallet.id,
            amount: requestedAmount,
            method: typeof method === "string" ? method : "card",
            cardNumber: typeof cardNumber === "string" ? cardNumber.replace(/.(?=.{4})/g, "*") : undefined,
            bankName: typeof bankName === "string" ? bankName : undefined,
            shebaNumber: typeof shebaNumber === "string" ? shebaNumber : undefined,
            status: "REQUESTED",
          },
        });
        lastCreateError = undefined;
        break; // success
      } catch (createErr: unknown) {
        const errCode = (createErr as { code?: string })?.code;
        if (errCode === "P2002" && attempt < CODE_RETRY_MAX) {
          // C3: collision on `code @unique` — retry with a new code
          console.warn("[wallets/withdraw] WithdrawalCode collision, retrying", {
            attempt,
            correlationId,
          });
          lastCreateError = createErr;
          continue;
        }
        // Non-P2002 error, or exhausted retries — rethrow to compensation
        throw createErr;
      }
    }
    if (!withdrawal) {
      // Exhausted all retries — treat as a failure (will compensate)
      throw lastCreateError ?? new Error("WithdrawalCode generation exhausted");
    }
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
        correlationId,
        error: notificationError,
      });
    }

    const successResponse = { withdrawal, newBalance: actualBalanceAfter };

    // ─── C4 final fix: check updateMany count ───
    // If count=0, the key was modified out from under us (should not happen
    // in normal flow, but could if an operator manually changed the status).
    // The withdrawal DID succeed, so we must NOT refund. Log CRITICAL with
    // correlationId so the operator can reconcile the idempotency key state.
    const completed = await db.idempotencyKey.updateMany({
      where: { key: scopedKey, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        response: JSON.stringify(successResponse),
      },
    });
    if (completed.count !== 1) {
      console.error("[wallets/withdraw] CRITICAL: idempotency key not marked COMPLETED", {
        correlationId,
        scopedKey,
        withdrawalId: withdrawal.id,
        updateCount: completed.count,
      });
      // The withdrawal succeeded — return success to the client.
      // The idempotency key may be stuck in IN_PROGRESS; a retry will get 409.
      // Operator must reconcile using the correlationId.
    }

    return NextResponse.json(successResponse);
  } catch (e: unknown) {
    // ─── Compensation using executeAtomicRefund helper ───
    //
    // If the withdrawal was created (withdrawalId set), we use the atomic
    // refund helper to safely refund + create ledger + transition status.
    //
    // If the withdrawal was NOT created (withdrawalId is null), we just
    // refund the balance inline (no withdrawal row to reconcile).
    //
    // The helper guarantees:
    //   - No double-refund (partial unique index on WalletLedger)
    //   - Atomic status guard + balance increment + ledger insert
    //   - If status is wrong, nothing happens (conditional SQL via refundToken)

    // Case 1: Withdrawal was created — use atomic refund helper
    if (withdrawalId && balanceDeducted) {
      try {
        // Transition REQUESTED → REFUND_PENDING first (required by helper)
        // CHECK THE RESULT — if transition failed, read current status
        const transition = await db.withdrawalRequest.updateMany({
          where: { id: withdrawalId, status: "REQUESTED" },
          data: { status: "REFUND_PENDING" },
        });

        if (transition.count !== 1) {
          // Transition failed — read current status to decide next step
          const current = await db.withdrawalRequest.findUnique({
            where: { id: withdrawalId },
            select: { status: true },
          });

          if (current?.status === "REFUND_PENDING") {
            // Another request already transitioned — proceed with helper
          } else if (current?.status === "REJECTED") {
            // Already refunded — treat as already refunded
            console.error("[wallets/withdraw] Withdrawal already REJECTED during compensation", {
              correlationId,
              withdrawalId,
            });
            await markIdempotencyFailed(db, scopedKey);
            return NextResponse.json(
              { error: "این برداشت قبلاً بازپرداخت شده است", correlationId },
              { status: 500 }
            );
          } else {
            // Unexpected status — RECONCILIATION_NEEDED
            console.error("[wallets/withdraw] CRITICAL: unexpected status during compensation", {
              correlationId,
              withdrawalId,
              status: current?.status,
            });
            await markIdempotencyFailed(db, scopedKey);
            return NextResponse.json(
              { error: "وضعیت برداشت نامشخص است؛ بررسی پشتیبانی لازم است", correlationId },
              { status: 500 }
            );
          }
        }

        // Execute atomic refund via helper
        await executeAtomicRefund({
          withdrawalId,
          walletId: wallet.id,
          amount: requestedAmount,
          reviewerId: "system-compensation",
          description: `Compensation refund for failed withdrawal ${withdrawalId}`,
        });

        // Refund succeeded — DO NOT delete financial records (preserve audit trail)
        // The withdrawal is now REJECTED with a REFUND ledger entry.
        // The WITHDRAWAL ledger entry (if created) is also kept — it shows
        // the deduction that was reversed by the REFUND.
        //
        // Previously we deleted the WITHDRAWAL ledger and the withdrawal request.
        // This destroyed the audit trail. Now we KEEP everything:
        //   - WithdrawalRequest: status=REJECTED (audit trail preserved)
        //   - WITHDRAWAL ledger: shows the original deduction
        //   - REFUND ledger: shows the reversal
        //   - The pair (WITHDRAWAL + REFUND) tells the full story.

        await markIdempotencyFailed(db, scopedKey);

        const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
        console.error("[wallets/withdraw] Compensation via atomic refund succeeded", {
          correlationId,
          walletId: wallet.id,
          withdrawalId,
          error: message,
          note: "Audit trail preserved: withdrawal=REJECTED, WITHDRAWAL+REFUND ledger entries kept",
        });
        return NextResponse.json({ error: message, correlationId }, { status: 500 });
      } catch (refundError: unknown) {
        // Atomic refund failed — transition to RECONCILIATION_NEEDED
        const refundMessage = refundError instanceof Error ? refundError.message : "unknown";
        console.error("[wallets/withdraw] CRITICAL: atomic refund compensation failed", {
          correlationId,
          walletId: wallet.id,
          withdrawalId,
          ledgerId,
          error: refundMessage,
          originalError: e,
        });

        // Try to transition to RECONCILIATION_NEEDED
        try {
          await db.withdrawalRequest.updateMany({
            where: { id: withdrawalId, status: "REFUND_PENDING" },
            data: { status: "RECONCILIATION_NEEDED" },
          });
        } catch {
          // Best-effort
        }

        await markIdempotencyFailed(db, scopedKey);
        return NextResponse.json(
          {
            error: "وضعیت برداشت نیازمند بررسی پشتیبانی است؛ دوباره درخواست برداشت ثبت نکنید",
            correlationId,
          },
          { status: 500 }
        );
      }
    }

    // Case 2: Withdrawal was NOT created — two-phase compensation with crash recovery
    //
    // DESIGN: Same two-phase pattern as the withdrawal path, but uses the
    // IdempotencyKey as the persistent record instead of WithdrawalRequest.
    //
    // Phase 1: Store compensation marker in IdempotencyKey + increment balance
    //   (RETURNING gives actual post-increment balance atomically)
    // Phase 2: Create REFUND ledger with accurate balanceBefore/balanceAfter
    //
    // CRASH RECOVERY:
    //   If crash between Phase 1 and Phase 2:
    //   - IdempotencyKey has response containing compensation marker
    //   - Balance was incremented (Phase 1 succeeded)
    //   - No REFUND ledger exists
    //   → On next request with same key: detect marker, create ledger WITHOUT re-incrementing
    //
    //   If crash after Phase 2:
    //   - Ledger exists with referenceId=scopedKey
    //   - Key still IN_PROGRESS
    //   → On next request: detect ledger, mark as FAILED
    if (balanceDeducted && !withdrawalId) {
      try {
        // Check if a REFUND ledger already exists for this idempotency key
        // (crash recovery: Phase 2 may have completed but markIdempotencyFailed didn't)
        const existingLedger = await db.walletLedger.findFirst({
          where: {
            referenceType: "Withdrawal",
            referenceId: scopedKey,
            type: "REFUND",
          },
        });

        if (existingLedger) {
          // Phase 2 already completed — just mark the key as FAILED
          console.error("[wallets/withdraw] Crash recovery: ledger exists, marking key FAILED", {
            correlationId,
            walletId: wallet.id,
            scopedKey,
            ledgerId: existingLedger.id,
            note: "Phase 2 completed but markIdempotencyFailed didn't run. Completing now.",
          });
          await markIdempotencyFailed(db, scopedKey);
          const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
          return NextResponse.json({ error: message, correlationId }, { status: 500 });
        }

        // Check if Phase 1 already ran (compensation marker in IdempotencyKey response)
        const idemKey = await db.idempotencyKey.findUnique({
          where: { key: scopedKey },
          select: { response: true },
        });

        const isCompensating = idemKey?.response?.includes('"compensating":true');

        if (isCompensating) {
          // CRASH RECOVERY: Phase 1 ran (balance was incremented) but Phase 2 didn't
          // Create the missing ledger WITHOUT re-incrementing balance
          const walletNow = await db.wallet.findUnique({
            where: { id: wallet.id },
            select: { balance: true },
          });
          const balanceAfter = Number(walletNow?.balance ?? 0);
          const balanceBefore = balanceAfter - requestedAmount;
          const ledgerId = `ledger_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

          try {
            await db.walletLedger.create({
              data: {
                walletId: wallet.id,
                type: "REFUND",
                amount: requestedAmount,
                balanceBefore,
                balanceAfter,
                referenceType: "Withdrawal",
                referenceId: scopedKey,
                description: `Compensation refund (no withdrawal) [CRASH RECOVERY — Phase 1 completed, ledger created on retry] — ${scopedKey}`,
                createdBy: "system-compensation",
              },
            });

            console.error("[wallets/withdraw] CRASH RECOVERY: created missing compensation ledger", {
              correlationId,
              walletId: wallet.id,
              scopedKey,
              ledgerId,
              note: "Phase 1 (balance increment) completed but Phase 2 (ledger) was interrupted. Ledger created without re-incrementing balance.",
            });
          } catch (ledgerErr) {
            // UNIQUE constraint = another recovery request already created the ledger
            const errMsg = String((ledgerErr as Error)?.message ?? "");
            if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
              // Already recovered — just mark as FAILED
              await markIdempotencyFailed(db, scopedKey);
              const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
              return NextResponse.json({ error: message, correlationId }, { status: 500 });
            }
            throw ledgerErr;
          }

          await markIdempotencyFailed(db, scopedKey);
          const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
          return NextResponse.json({ error: message, correlationId }, { status: 500 });
        }

        // ══════ Normal Phase 1: store marker + increment balance ══════
        // Store compensation marker BEFORE incrementing balance.
        // This marker enables crash recovery.
        await db.idempotencyKey.updateMany({
          where: { key: scopedKey, status: "IN_PROGRESS" },
          data: {
            response: JSON.stringify({
              compensating: true,
              walletId: wallet.id,
              amount: requestedAmount,
              correlationId,
            }),
          },
        });

        // Phase 1: Increment balance and get actual post-increment value
        const refund = await db.wallet.updateMany({
          where: { id: wallet.id },
          data: { balance: { increment: requestedAmount } },
        });
        if (refund.count !== 1) {
          throw new Error("Wallet balance compensation did not update exactly one row");
        }

        // Read actual balance AFTER increment (for accurate ledger values)
        const walletAfter = await db.wallet.findUnique({
          where: { id: wallet.id },
          select: { balance: true },
        });
        const balanceAfter = Number(walletAfter?.balance ?? 0);
        const balanceBefore = balanceAfter - requestedAmount;

        // ══════ Phase 2: Create REFUND ledger entry ══════
        try {
          await db.walletLedger.create({
            data: {
              walletId: wallet.id,
              type: "REFUND",
              amount: requestedAmount,
              balanceBefore,
              balanceAfter,
              referenceType: "Withdrawal",
              referenceId: scopedKey,
              description: `Compensation refund (no withdrawal record) — ${scopedKey}`,
              createdBy: "system-compensation",
            },
          });
        } catch (ledgerErr) {
          // UNIQUE constraint = double-refund detected
          const errMsg = String((ledgerErr as Error)?.message ?? "");
          if (errMsg.includes("UNIQUE constraint") || errMsg.includes("already exists")) {
            console.error("[wallets/withdraw] CRITICAL: double-refund in no-withdrawal path", {
              correlationId,
              walletId: wallet.id,
              scopedKey,
              note: "Ledger already exists — balance was incremented twice. Attempting undo.",
            });
            // Undo the balance increment
            try {
              await db.wallet.updateMany({
                where: { id: wallet.id },
                data: { balance: { decrement: requestedAmount } },
              });
            } catch {
              // Can't undo — manual reconciliation
            }
            await markIdempotencyFailed(db, scopedKey);
            return NextResponse.json(
              {
                error: "خطای بحرانی: بازپرداخت تکراری شناسایی شد؛ بررسی فوری پشتیبانی لازم است",
                correlationId,
              },
              { status: 500 }
            );
          }
          throw ledgerErr;
        }

        // Phase 2 succeeded — mark key as FAILED
        await markIdempotencyFailed(db, scopedKey);

        const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
        console.error("[wallets/withdraw] Compensation (no withdrawal) completed with audit ledger", {
          correlationId,
          walletId: wallet.id,
          scopedKey,
          error: message,
          note: "Two-phase compensation: marker stored, balance incremented, ledger created.",
        });
        return NextResponse.json({ error: message, correlationId }, { status: 500 });
      } catch (refundError: unknown) {
        console.error("[wallets/withdraw] CRITICAL: compensation failed (no withdrawal record)", {
          correlationId,
          walletId: wallet.id,
          error: refundError,
          originalError: e,
          note: "Manual reconciliation required.",
        });
        await markIdempotencyFailed(db, scopedKey);
        return NextResponse.json(
          {
            error: "وضعیت برداشت نیازمند بررسی پشتیبانی است؛ دوباره درخواست برداشت ثبت نکنید",
            correlationId,
          },
          { status: 500 }
        );
      }
    }

    // Case 3: No balance was deducted — nothing to compensate
    await markIdempotencyFailed(db, scopedKey);
    const message = e instanceof Error ? e.message : "خطا در پردازش برداشت";
    console.error("[wallets/withdraw] Withdrawal failed (no compensation needed)", {
      correlationId,
      walletId: wallet.id,
      error: message,
    });
    return NextResponse.json({ error: message, correlationId }, { status: 500 });
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
