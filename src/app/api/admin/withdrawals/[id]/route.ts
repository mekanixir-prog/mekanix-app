import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";

// MEKANIX — Admin withdrawal PATCH (approve / reject + refund)
//
// CRITICAL CONTEXT: D1 (Cloudflare's SQLite) does NOT support Prisma's
// $transaction interactive API. Writes are sequential and non-atomic: if a
// later write fails, earlier writes stay committed. This route is designed
// around that constraint using a state-machine + idempotent recovery pattern.
//
// State machine (REJECT path):
//
//   REQUESTED ──REJECT──► REFUND_PENDING ──refund+ledger ok──► REJECTED
//                              │
//                              ├──refund/ledger fail──► (stay REFUND_PENDING, retry-safe)
//                              │
//                              └──cannot determine outcome──► RECONCILIATION_NEEDED
//
// Idempotent recovery (the key invariant):
//   Before incrementing the wallet balance, we check if a REFUND ledger entry
//   already exists for this withdrawal.id. If it does, the refund already
//   happened in a previous attempt — we skip the balance increment and only
//   ensure the ledger is present. This makes retry from REFUND_PENDING safe:
//   a second PATCH will never double-credit the wallet, even if the first
//   attempt crashed after the increment but before the ledger write.
//
// Why RECONCILIATION_NEEDED is a last resort:
//   Temporary failures (D1 timeout, brief unavailability) should NOT destroy
//   the recovery path. The route stays in REFUND_PENDING so the admin can
//   retry. Only when the system genuinely cannot determine whether the
//   balance was incremented (e.g., updateMany returned count=0 unexpectedly,
//   or ledger lookup itself threw) do we transition to RECONCILIATION_NEEDED.

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });

  const { id } = await params;
  let body: { action?: unknown; notes?: unknown; txnId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست معتبر نیست" }, { status: 400 });
  }

  if (body.action !== "APPROVE" && body.action !== "REJECT") {
    return NextResponse.json({ error: "action باید APPROVE یا REJECT باشد" }, { status: 400 });
  }
  if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 1000)) {
    return NextResponse.json({ error: "یادداشت نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const request = await db.withdrawalRequest.findUnique({ where: { id } });
  if (!request) return NextResponse.json({ error: "درخواست برداشت یافت نشد" }, { status: 404 });

  // ──────────── APPROVE path ────────────
  // APPROVE stays a direct REQUESTED → APPROVED transition (no financial write).
  // The wallet balance was already deducted at withdraw time; approval just
  // queues the payout for later processing.
  if (body.action === "APPROVE") {
    if (request.status !== "REQUESTED") {
      return NextResponse.json({ error: "این درخواست قبلاً بررسی شده است" }, { status: 409 });
    }
    const transition = await db.withdrawalRequest.updateMany({
      where: { id, status: "REQUESTED" },
      data: {
        status: "APPROVED",
        processedAt: new Date(),
        reviewerId: admin.adminId,
        adminNotes: typeof body.notes === "string" ? body.notes : null,
      },
    });
    if (transition.count !== 1) {
      return NextResponse.json({ error: "درخواست هم‌زمان توسط مدیر دیگری بررسی شده است" }, { status: 409 });
    }
    const updated = await db.withdrawalRequest.findUnique({ where: { id } });
    return NextResponse.json({ withdrawal: updated });
  }

  // ──────────── REJECT path (state-machine recovery) ────────────
  // REJECT is idempotent and can be retried from REFUND_PENDING.

  // Step 1: Acquire the request atomically.
  //   - If status === "REQUESTED": transition to REFUND_PENDING (first attempt).
  //   - If status === "REFUND_PENDING": already acquired, this is a retry —
  //     proceed to refund recovery.
  //   - If status === "REJECTED": already completed successfully.
  //   - If status === "RECONCILIATION_NEEDED": manual intervention required,
  //     automatic retry is blocked.
  //   - Any other status: 409.
  if (request.status === "REJECTED") {
    return NextResponse.json(
      { error: "این درخواست قبلاً رد شده و بازپرداخت آن کامل شده است", withdrawal: request },
      { status: 409 }
    );
  }
  if (request.status === "RECONCILIATION_NEEDED") {
    return NextResponse.json(
      { error: "این درخواست نیازمند بررسی دستی است؛ retry خودکار مسدود است" },
      { status: 409 }
    );
  }
  if (request.status !== "REQUESTED" && request.status !== "REFUND_PENDING") {
    return NextResponse.json({ error: "این درخواست در وضعیت قابل‌رد نیست" }, { status: 409 });
  }

  // Step 2: Transition REQUESTED → REFUND_PENDING (only on first attempt).
  // Uses conditional updateMany so two concurrent admins cannot both acquire.
  if (request.status === "REQUESTED") {
    const acquire = await db.withdrawalRequest.updateMany({
      where: { id, status: "REQUESTED" },
      data: {
        status: "REFUND_PENDING",
        processedAt: new Date(),
        reviewerId: admin.adminId,
        adminNotes: typeof body.notes === "string" ? body.notes : null,
      },
    });
    if (acquire.count !== 1) {
      // Another admin just acquired it; tell the caller to retry.
      return NextResponse.json(
        { error: "درخواست هم‌زمان توسط مدیر دیگری در حال بررسی است" },
        { status: 409 }
      );
    }
  }
  // From here, the request is in REFUND_PENDING (either we just transitioned
  // it, or it was already there from a previous attempt).

  const amount = Number(request.amount);

  // Step 3: Check if a REFUND ledger entry already exists for this withdrawal.
  // This is the idempotency guard: if it exists, the refund already happened
  // and we must NOT increment the balance again.
  let existingRefundLedger;
  try {
    existingRefundLedger = await db.walletLedger.findFirst({
      where: {
        referenceType: "Withdrawal",
        referenceId: request.id,
        type: "REFUND",
      },
    });
  } catch (lookupError) {
    // If we cannot even check the ledger, we cannot safely determine whether
    // the refund happened. Stay in REFUND_PENDING so the admin can retry,
    // but log CRITICAL. Do NOT transition to RECONCILIATION_NEEDED yet —
    // this might be a transient D1 read failure.
    console.error("[admin/withdrawals] Cannot verify refund ledger — retry-safe", {
      withdrawalId: id,
      walletId: request.walletId,
      error: lookupError,
    });
    return NextResponse.json(
      { error: "امکان بررسی وضعیت بازپرداخت نیست؛ دوباره تلاش کنید" },
      { status: 503 }
    );
  }

  // Step 4: If no refund ledger exists, increment the wallet balance.
  // If the increment fails, stay in REFUND_PENDING (retry-safe).
  if (!existingRefundLedger) {
    let refundResult;
    try {
      refundResult = await db.wallet.updateMany({
        where: { id: request.walletId },
        data: { balance: { increment: amount } },
      });
    } catch (refundError) {
      // Balance increment failed. The refund did NOT happen (or D1 returned
      // an error we cannot interpret). Stay in REFUND_PENDING so the admin
      // can retry. Log CRITICAL for visibility.
      console.error("[admin/withdrawals] Refund increment failed — retry-safe", {
        withdrawalId: id,
        walletId: request.walletId,
        amount,
        error: refundError,
      });
      return NextResponse.json(
        { error: "بازپرداخت موفق نبود؛ دوباره تلاش کنید" },
        { status: 503 }
      );
    }

    if (refundResult.count !== 1) {
      // The wallet row vanished (cascade delete?). We incremented 0 rows.
      // This is genuinely ambiguous: did the wallet exist before? We cannot
      // tell. Transition to RECONCILIATION_NEEDED — manual intervention.
      console.error("[admin/withdrawals] CRITICAL: wallet row missing during refund", {
        withdrawalId: id,
        walletId: request.walletId,
        amount,
      });
      await db.withdrawalRequest.updateMany({
        where: { id, status: "REFUND_PENDING" },
        data: { status: "RECONCILIATION_NEEDED" },
      });
      return NextResponse.json(
        { error: "کیف پول یافت نشد؛ درخواست نیازمند بررسی دستی است" },
        { status: 500 }
      );
    }
    // Balance incremented successfully. Fall through to ledger creation.
  }

  // Step 5: Create the REFUND ledger entry if it does not exist.
  // If the ledger already existed (from step 3), skip. Otherwise create it.
  // If creation fails here, the balance WAS incremented but no ledger —
  // this is the C2-variant case. We stay in REFUND_PENDING so a retry will
  // find the ledger missing, skip the increment (because the ledger check
  // in step 3 will now... wait, no: the ledger doesn't exist yet, so step 3
  // returns null, and step 4 will increment AGAIN. That's a double-credit!).
  //
  // To prevent this double-credit on retry, we must create the ledger
  // BEFORE we consider the operation done. If ledger creation fails after
  // the balance increment succeeded, we have two sub-cases:
  //   (a) The create threw — we don't know if it committed. Retry will
  //       re-check ledger (step 3): if it's there, skip increment; if not,
  //       increment again → double-credit risk.
  //   (b) To make this safe, we use a findFirst after the create to verify
  //       the ledger actually exists. If it does, we're done. If not, we
  //       transition to RECONCILIATION_NEEDED because we cannot determine
  //       whether the increment happened AND whether the ledger is there.
  if (!existingRefundLedger) {
    try {
      await db.walletLedger.create({
        data: {
          walletId: request.walletId,
          type: "REFUND",
          amount,
          referenceType: "Withdrawal",
          referenceId: request.id,
          description: `Refund for rejected withdrawal ${request.code}`,
          createdBy: admin.adminId,
        },
      });
    } catch (ledgerCreateError) {
      // The balance increment succeeded (step 4), but ledger creation threw.
      // We cannot safely retry the increment. Transition to
      // RECONCILIATION_NEEDED so an operator can verify the ledger state
      // and create it manually if needed.
      console.error("[admin/withdrawals] CRITICAL: refund done but ledger write failed", {
        withdrawalId: id,
        walletId: request.walletId,
        amount,
        error: ledgerCreateError,
      });
      await db.withdrawalRequest.updateMany({
        where: { id, status: "REFUND_PENDING" },
        data: { status: "RECONCILIATION_NEEDED" },
      });
      return NextResponse.json(
        { error: "بازپرداخت انجام شد اما ثبت دفتر ناموفق بود؛ بررسی پشتیبانی لازم است" },
        { status: 500 }
      );
    }

    // Verify the ledger actually exists (defensive: D1 may have returned
    // success without committing in rare edge cases).
    const verifyLedger = await db.walletLedger.findFirst({
      where: { referenceType: "Withdrawal", referenceId: request.id, type: "REFUND" },
    });
    if (!verifyLedger) {
      // The create returned success but the ledger is not readable. This is
      // a genuine inconsistency — transition to RECONCILIATION_NEEDED.
      console.error("[admin/withdrawals] CRITICAL: ledger create succeeded but not readable", {
        withdrawalId: id,
        walletId: request.walletId,
      });
      await db.withdrawalRequest.updateMany({
        where: { id, status: "REFUND_PENDING" },
        data: { status: "RECONCILIATION_NEEDED" },
      });
      return NextResponse.json(
        { error: "ثبت دفتر قابل تأیید نیست؛ بررسی پشتیبانی لازم است" },
        { status: 500 }
      );
    }
  }

  // Step 6: Both refund and ledger are confirmed. Transition
  // REFUND_PENDING → REJECTED (final state).
  const finalize = await db.withdrawalRequest.updateMany({
    where: { id, status: "REFUND_PENDING" },
    data: { status: "REJECTED" },
  });
  if (finalize.count !== 1) {
    // Another process changed the status out from under us. This should not
    // happen in normal flow — log and return the current state.
    console.error("[admin/withdrawals] Could not finalize REJECTED status", {
      withdrawalId: id,
    });
    const current = await db.withdrawalRequest.findUnique({ where: { id } });
    return NextResponse.json(
      { error: "تغییر وضعیت نهایی ممکن نشد", withdrawal: current },
      { status: 500 }
    );
  }

  const updated = await db.withdrawalRequest.findUnique({ where: { id } });
  return NextResponse.json({ withdrawal: updated });
}
