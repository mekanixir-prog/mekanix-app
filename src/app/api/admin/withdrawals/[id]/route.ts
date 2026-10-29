import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { executeAtomicRefund } from "@/lib/atomic-refund";

// MEKANIX — Admin withdrawal PATCH (approve / reject + refund)
//
// REJECT path now uses executeAtomicRefund() helper which provides:
//   - D1 batch() atomicity (all statements commit or roll back together)
//   - SQLite $transaction() atomicity in dev
//   - Partial unique index prevents double-refund at DB level
//
// State machine:
//   REQUESTED ──REJECT──► REFUND_PENDING ──executeAtomicRefund──► REJECTED
//                              │
//                              └──any failure──► RECONCILIATION_NEEDED
//
// Safety: The atomic refund helper checks the status INSIDE the
// transaction/batch. If status is not REFUND_PENDING, nothing happens
// (no balance change). The partial unique index on WalletLedger makes
// double-refund impossible at the DB level.

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

  // ──────────── REJECT path ────────────
  // REJECT uses executeAtomicRefund() which handles the atomic refund.

  // Pre-checks for statuses that cannot be rejected:
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

  // If status is REQUESTED, transition to REFUND_PENDING first (acquire).
  // This uses conditional updateMany so two concurrent admins cannot both acquire.
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
        { error: "درخواست هم‌زمان توسط مدیر دیگری در حال بررسی است" },
        { status: 409 }
      );
    }
  } else if (request.status !== "REFUND_PENDING") {
    // Any other status (APPROVED, PAID) cannot be rejected
    return NextResponse.json({ error: "این درخواست در وضعیت قابل‌رد نیست" }, { status: 409 });
  }

  // Execute the atomic refund via the helper.
  // The helper handles ALL atomicity:
  //   - Status guard (REFUND_PENDING → REJECTED) inside transaction
  //   - Balance increment inside transaction
  //   - Ledger insert with unique index inside transaction
  //   - Idempotency: if already REJECTED, returns without double-refund
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
    // The atomic refund failed.
    const message = error instanceof Error ? error.message : "خطای ناشناخته";
    console.error("[admin/withdrawals] Atomic refund failed", {
      withdrawalId: id,
      walletId: request.walletId,
      error: message,
    });

    // Check current state — the helper guarantees no partial state (atomic rollback).
    const current = await db.withdrawalRequest.findUnique({ where: { id } });

    if (current?.status === "REJECTED") {
      // Another request won the race and completed the refund.
      return NextResponse.json({
        withdrawal: current,
        message: "درخواست قبلاً توسط مدیر دیگری رد شده است",
      });
    }

    // If still REFUND_PENDING, transition to RECONCILIATION_NEEDED.
    // The atomic refund failed but no partial state was committed.
    if (current?.status === "REFUND_PENDING") {
      await db.withdrawalRequest.updateMany({
        where: { id, status: "REFUND_PENDING" },
        data: { status: "RECONCILIATION_NEEDED" },
      });
      return NextResponse.json(
        { error: "بازپرداخت اتمیک ناموفق بود؛ درخواست به وضعیت نیازمند بررسی دستی منتقل شد", withdrawalId: id },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "خطا در پردازش بازپرداخت", details: message },
      { status: 500 }
    );
  }
}
