import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";

// Only permit one-way transitions from REQUESTED. The conditional update is
// the concurrency guard: two admins cannot both approve/reject the same request.
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
  if (request.status !== "REQUESTED") {
    return NextResponse.json({ error: "این درخواست قبلاً بررسی شده است" }, { status: 409 });
  }

  const nextStatus = body.action === "APPROVE" ? "APPROVED" : "REJECTED";
  const transition = await db.withdrawalRequest.updateMany({
    where: { id, status: "REQUESTED" },
    data: {
      status: nextStatus,
      processedAt: new Date(),
      reviewerId: admin.adminId,
      adminNotes: typeof body.notes === "string" ? body.notes : null,
    },
  });
  if (transition.count !== 1) {
    return NextResponse.json({ error: "درخواست هم‌زمان توسط مدیر دیگری بررسی شده است" }, { status: 409 });
  }

  if (nextStatus === "REJECTED") {
    try {
      const refund = await db.wallet.updateMany({
        where: { id: request.walletId },
        data: { balance: { increment: Number(request.amount) } },
      });
      if (refund.count !== 1) throw new Error("Wallet refund did not update exactly one row");
      await db.walletLedger.create({
        data: {
          walletId: request.walletId,
          type: "REFUND",
          amount: Number(request.amount),
          referenceType: "Withdrawal",
          referenceId: request.id,
          description: `Refund for rejected withdrawal ${request.code}`,
          createdBy: admin.adminId,
        },
      });
    } catch (error) {
      // The request transition prevents a duplicate refund. If a refund write
      // fails after status changed, do not retry the refund automatically:
      // it needs reconciliation to avoid double-crediting the wallet.
      console.error("[admin/withdrawals] CRITICAL: rejected withdrawal requires reconciliation", {
        withdrawalId: id,
        walletId: request.walletId,
        amount: String(request.amount),
        error,
      });
      return NextResponse.json(
        { error: "درخواست رد شد اما بازگشت موجودی کامل نشد؛ بررسی پشتیبانی لازم است" },
        { status: 500 }
      );
    }
  }

  const updated = await db.withdrawalRequest.findUnique({ where: { id } });
  return NextResponse.json({ withdrawal: updated });
}
