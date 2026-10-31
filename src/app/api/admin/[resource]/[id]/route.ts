import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { sanitizeInput, ALLOWED_FIELDS, FORBIDDEN_FIELDS } from "@/lib/auth";
import { writeAuditLog } from "@/lib/admin-api";
import { updateWithdrawalAtomically } from "@/lib/withdrawal-admin-atomic";
import { isValidIranianSheba } from "@/lib/iranian-iban";

// Mass-assignment protection: define per-resource whitelists.
const RESOURCE_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  // Technicians: admin can edit profile fields, but NOT server-authoritative metrics.
  technicians: ["bio", "experienceYears", "hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy", "availableNow", "responseMins", "lat", "lng", "heading", "status", "verified", "level"],
  // Customers: editable profile fields
  customers: ["company", "taxId"],
  // Service categories: full edit
  categories: ["slug", "name", "nameFa", "icon", "basePrice", "order", "active"],
  // Reviews: status only (publish / unpublish / flag)
  reviews: ["status"],
  // Payments: status only (mark as REFUNDED, etc.)
  payments: ["status"],
};

// S3 FIX: valid User status values, matching the UserStatus enum in
// prisma/schema.prisma. Any other value must be rejected with 400 BEFORE
// any DB write — never cast to `any` and pass to Prisma.
const VALID_USER_STATUSES = ["ACTIVE", "SUSPENDED", "PENDING"] as const;

// Valid Payment status values, matching PaymentStatus enum.
const VALID_PAYMENT_STATUSES = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED"] as const;

// SEC-4: helper to wrap writeAuditLog in try/catch so audit failure never
// blocks the mutation. Audit logs are best-effort — they MUST NOT break the
// admin workflow (otherwise operators couldn't fix data when the audit
// pipeline is degraded).
async function safeAudit(opts: {
  session: { adminId: string; username: string; role: string };
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  req?: Request;
}) {
  try {
    await writeAuditLog(opts);
  } catch (e) {
    console.error(`[audit log error] ${opts.action}`, e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ resource: string; id: string }> }) {
  const adminSession = await getAdminFromRequest(req);
  if (!adminSession) {
    return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });
  }

  const { resource, id } = await params;

  let body: Record<string, any>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "JSON body must be an object" }, { status: 400 });
    }
    body = parsed as Record<string, any>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // S3 FIX: validate user.status BEFORE stripping FORBIDDEN_FIELDS.
  const requestedUserStatus = body.status;
  const requestedWithdrawalStatus = body.status;
  const requestedWithdrawalAdminNotes = body.adminNotes;
  const requestedWithdrawalReference = body.transactionReference;
  if (resource === "customers" && requestedUserStatus !== undefined) {
    if (
      typeof requestedUserStatus !== "string" ||
      !(VALID_USER_STATUSES as readonly string[]).includes(requestedUserStatus)
    ) {
      return NextResponse.json(
        { error: `status باید یکی از ${VALID_USER_STATUSES.join("، ")} باشد` },
        { status: 400 }
      );
    }
  }

  // Mass-assignment: strip forbidden fields (defense in depth)
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      delete body[key];
    }
  }

  const db = await getDbForLib();
  let result: any = null;

  if (resource === "technicians") {
    const allowed = RESOURCE_ALLOWED_FIELDS.technicians ?? ALLOWED_FIELDS.technician;
    const safe = sanitizeInput(body, allowed);
    // SEC-4: snapshot BEFORE the update for audit log.
    const before = await db.technician.findUnique({ where: { id } });
    result = await db.technician.update({ where: { id }, data: safe as any, include: { user: true } });
    await safeAudit({ session: adminSession, action: "UPDATE_TECHNICIAN", entity: "technician", entityId: id, before, after: result, req });
  } else if (resource === "customers") {
    // Allow direct updates to customer record (company, taxId) — but block userId
    const allowed = RESOURCE_ALLOWED_FIELDS.customers ?? ALLOWED_FIELDS.profile;
    const safe = sanitizeInput(body, allowed);

    // Mid-failure ordering: update user.status FIRST (security-critical —
    // ban/activate the user), THEN update customer profile fields. If the
    // second write fails, the user IS banned/activated (the security action
    // took effect) — the admin can retry to complete the profile update.
    if (typeof requestedUserStatus === "string") {
      const customer = await db.customer.findUnique({ where: { id }, select: { userId: true } });
      if (customer) {
        // SEC-4: snapshot the user BEFORE the status change.
        const userBefore = await db.user.findUnique({
          where: { id: customer.userId },
          select: { id: true, status: true },
        });
        await db.user.update({
          where: { id: customer.userId },
          data: { status: requestedUserStatus as (typeof VALID_USER_STATUSES)[number] },
        });
        // SEC-4: audit log the user status change (best-effort).
        await safeAudit({
          session: adminSession,
          action: "CHANGE_USER_STATUS",
          entity: "user",
          entityId: customer.userId,
          before: userBefore,
          after: { id: customer.userId, status: requestedUserStatus },
          req,
        });
      }
    }
    // SEC-4: snapshot the customer BEFORE the profile update.
    const before = await db.customer.findUnique({ where: { id } });
    result = await db.customer.update({ where: { id }, data: safe as any, include: { user: true } });
    await safeAudit({ session: adminSession, action: "UPDATE_CUSTOMER", entity: "customer", entityId: id, before, after: result, req });
  } else if (resource === "categories") {
    const allowed = RESOURCE_ALLOWED_FIELDS.categories ?? ALLOWED_FIELDS.profile;
    const safe = sanitizeInput(body, allowed);
    // SEC-4: snapshot BEFORE.
    const before = await db.serviceCategory.findUnique({ where: { id } });
    result = await db.serviceCategory.update({ where: { id }, data: safe as any });
    await safeAudit({ session: adminSession, action: "UPDATE_CATEGORY", entity: "serviceCategory", entityId: id, before, after: result, req });
  } else if (resource === "reviews") {
    const allowed = RESOURCE_ALLOWED_FIELDS.reviews ?? ALLOWED_FIELDS.review;
    const safe = sanitizeInput(body, allowed);
    // SEC-4: snapshot BEFORE.
    const before = await db.review.findUnique({ where: { id } });
    result = await db.review.update({ where: { id }, data: safe as any });
    await safeAudit({ session: adminSession, action: "UPDATE_REVIEW", entity: "review", entityId: id, before, after: result, req });
  } else if (resource === "withdrawals") {
    const action = requestedWithdrawalStatus;
    if (!["APPROVED", "REJECTED", "PAID"].includes(action)) {
      return NextResponse.json({ error: "وضعیت عملیات برداشت نامعتبر است" }, { status: 400 });
    }
    const adminNotes = requestedWithdrawalAdminNotes === undefined ? null : requestedWithdrawalAdminNotes;
    if (adminNotes !== null && (typeof adminNotes !== "string" || adminNotes.length > 500)) {
      return NextResponse.json({ error: "یادداشت مدیر نامعتبر است" }, { status: 400 });
    }

    const before = await db.withdrawalRequest.findUnique({
      where: { id },
      select: {
        id: true, code: true, walletId: true, amount: true, method: true,
        status: true, requestedAt: true, processedAt: true, reviewerId: true,
        adminNotes: true, txnId: true, shebaNumber: true,
        wallet: { select: { technician: { select: { userId: true } } } },
      },
    });
    if (!before) return NextResponse.json({ error: "درخواست برداشت پیدا نشد" }, { status: 404 });

    let payoutReference: string | null = null;
    if (action === "PAID") {
      payoutReference = typeof requestedWithdrawalReference === "string"
        ? requestedWithdrawalReference.trim()
        : null;
      if (!payoutReference || payoutReference.length < 3 || payoutReference.length > 128 || /[\\u0000-\\u001F\\u007F]/.test(payoutReference)) {
        return NextResponse.json({ error: "شناسه پیگیری واقعی انتقال بانکی الزامی و نامعتبر است" }, { status: 400 });
      }
      if (before.status === "PAID") {
        if (before.txnId === payoutReference) return NextResponse.json({ ...before, idempotent: true });
        return NextResponse.json({ error: "این برداشت قبلاً با شناسه پیگیری دیگری پرداخت شده است" }, { status: 409 });
      }
      if (before.status !== "APPROVED") {
        return NextResponse.json({ error: "ابتدا باید درخواست برداشت تأیید شود" }, { status: 409 });
      }
      if (before.method !== "bank" || !isValidIranianSheba(before.shebaNumber)) {
        return NextResponse.json(
          { error: "برای ثبت پرداخت، درخواست باید دارای شبای معتبر باشد؛ شماره کارت به‌صورت امن ماسک شده است" },
          { status: 409 }
        );
      }
    }

    const changed = await updateWithdrawalAtomically(db, {
      withdrawalId: id,
      action,
      adminId: adminSession.adminId,
      adminNotes,
      payoutReference,
      at: new Date(),
    });
    if (!changed) {
      return NextResponse.json({ error: "وضعیت درخواست تغییر کرده یا عملیات قبلاً انجام شده است" }, { status: 409 });
    }

    result = await db.withdrawalRequest.findUnique({
      where: { id },
      select: {
        id: true, code: true, walletId: true, amount: true, method: true,
        status: true, requestedAt: true, processedAt: true, reviewerId: true,
        adminNotes: true, txnId: true,
        wallet: { select: { technician: { select: { userId: true } } } },
      },
    });
    await safeAudit({
      session: adminSession,
      action: `WITHDRAWAL_${action}`,
      entity: "withdrawalRequest",
      entityId: id,
      before,
      after: result,
      req,
    });

    // Notify the technician after the financial state has committed.
    try {
      const userId = before.wallet.technician.userId;
      const message = action === "APPROVED"
        ? "درخواست برداشت شما تأیید شد و در صف پرداخت قرار گرفت."
        : action === "REJECTED"
          ? "درخواست برداشت رد شد و مبلغ به کیف پول شما بازگشت."
          : "پرداخت درخواست برداشت شما ثبت شد.";
      await db.notification.create({
        data: {
          userId,
          type: action === "PAID" ? "payout_processed" : "withdrawal_updated",
          title: action === "APPROVED" ? "درخواست برداشت تأیید شد" : action === "REJECTED" ? "مبلغ برداشت بازگشت داده شد" : "پرداخت برداشت انجام شد",
          body: message,
          category: "payment",
          link: "technician/earnings",
        },
      });
    } catch {
      // Notifications are best-effort and cannot undo a committed financial action.
    }
  } else if (resource === "payments") {
    const allowed = RESOURCE_ALLOWED_FIELDS.payments ?? ALLOWED_FIELDS.review;
    const safe = sanitizeInput(body, allowed);
    // Validate payment status if provided
    if (typeof body.status === "string" && !(VALID_PAYMENT_STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json(
        { error: `status باید یکی از ${VALID_PAYMENT_STATUSES.join("، ")} باشد` },
        { status: 400 }
      );
    }
    // SEC-4: snapshot BEFORE.
    const before = await db.payment.findUnique({ where: { id } });
    result = await db.payment.update({ where: { id }, data: safe as any });
    await safeAudit({ session: adminSession, action: "UPDATE_PAYMENT", entity: "payment", entityId: id, before, after: result, req });
  } else {
    return NextResponse.json({ error: "Unsupported resource" }, { status: 400 });
  }
  return NextResponse.json(result);
}
