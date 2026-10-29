import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { executeAtomicRefund } from "@/lib/atomic-refund";

// MEKANIX — Admin withdrawal PATCH (approve / reject + refund)
//
// CRITICAL CONTEXT: D1 (Cloudflare's SQLite) does NOT support Prisma's
// $transaction interactive API. Writes are sequential and non-atomic: if a
// later write fails, earlier writes stay committed. This route is designed
// around that constraint using a state-machine + idempotent recovery pattern.
//
// State machine (REJECT path):
//
//   REQUESTED → REFUND_PENDING → REFUND_PROCESSING → REJECTED
//                                      │
//                                      └─ ambiguous/crash → RECONCILIATION_NEEDED
//
// REFUND_PROCESSING is a durable crash barrier: after claiming it, no second
// request may increment the wallet again unless a REFUND ledger already exists.
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
//   or a write outcome is ambiguous) do we transition to RECONCILIATION_NEEDED.

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

  // ──────────── REJECT path: atomic refund ────────────
  if (request.status === "REJECTED") {
    const ledger = await db.walletLedger.findFirst({
      where: { referenceType: "Withdrawal", referenceId: id, type: "REFUND" },
    });
    if (ledger) {
      return NextResponse.json({ withdrawal: request, refund: { success: true, alreadyRefunded: true } });
    }
    await db.withdrawalRequest.updateMany({
      where: { id, status: "REJECTED" },
      data: { status: "RECONCILIATION_NEEDED" },
    });
    return NextResponse.json(
      { error: "درخواست رد شده اما سند بازپرداخت ندارد؛ بررسی دستی لازم است", withdrawalId: id },
      { status: 409 }
    );
  }
  if (request.status === "RECONCILIATION_NEEDED") {
    return NextResponse.json(
      { error: "این درخواست نیازمند بررسی دستی است؛ retry خودکار مسدود است" },
      { status: 409 }
    );
  }

  // Legacy REFUND_PROCESSING means an older request may have stopped between
  // financial writes. Never credit it again automatically.
  if (request.status === "REFUND_PROCESSING") {
    const ledger = await db.walletLedger.findFirst({
      where: { referenceType: "Withdrawal", referenceId: id, type: "REFUND" },
    });
    if (ledger) {
      await db.withdrawalRequest.updateMany({
        where: { id, status: "REFUND_PROCESSING" },
        data: { status: "REJECTED" },
      });
      const updated = await db.withdrawalRequest.findUnique({ where: { id } });
      return NextResponse.json({ withdrawal: updated, refund: { success: true, alreadyRefunded: true } });
    }
    await db.withdrawalRequest.updateMany({
      where: { id, status: "REFUND_PROCESSING" },
      data: { status: "RECONCILIATION_NEEDED" },
    });
    return NextResponse.json(
      { error: "پردازش بازپرداخت قبلی نیمه‌تمام است؛ بررسی دستی لازم است", withdrawalId: id },
      { status: 409 }
    );
  }

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
      return NextResponse.json(
        { error: "درخواست هم‌زمان توسط مدیر دیگری بررسی شده است" },
        { status: 409 }
      );
    }
  } else if (request.status !== "REFUND_PENDING") {
    return NextResponse.json({ error: "این درخواست در وضعیت قابل‌رد نیست" }, { status: 409 });
  }

  try {
    const result = await executeAtomicRefund({
      withdrawalId: id,
      walletId: request.walletId,
      amount: Number(request.amount),
      reviewerId: admin.adminId,
      description: `Refund for rejected withdrawal ${request.code}`,
    });
    const updated = await db.withdrawalRequest.findUnique({ where: { id } });
    return NextResponse.json({
      withdrawal: updated,
      refund: {
        success: result.success,
        alreadyRefunded: result.alreadyRefunded,
        newBalance: result.newBalance,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "خطای ناشناخته";
    console.error("[admin/withdrawals] Atomic refund failed", {
      withdrawalId: id,
      walletId: request.walletId,
      error: message,
    });

    // Resolve an uncertain response by checking the durable ledger. If it
    // exists, money was credited and a retry must not credit again.
    const current = await db.withdrawalRequest.findUnique({ where: { id } });
    const ledger = await db.walletLedger.findFirst({
      where: { referenceType: "Withdrawal", referenceId: id, type: "REFUND" },
    });
    if (ledger && current?.status === "REJECTED") {
      return NextResponse.json({
        withdrawal: current,
        refund: { success: true, alreadyRefunded: true },
      });
    }
    if (current?.status === "REFUND_PENDING") {
      // The helper uses a transaction/batch for all financial writes. Leave
      // this state retryable when no refund ledger proves a committed refund.
      return NextResponse.json(
        { error: "بازپرداخت اتمیک انجام نشد؛ بدون ثبت سند مالی دوباره تلاش کنید", withdrawalId: id },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "وضعیت بازپرداخت مبهم است؛ بررسی دستی لازم است", withdrawalId: id },
      { status: 500 }
    );
  }
}
