import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requirePolicyOwner } from "@/lib/auth";
import { IdempotencyConflictError, readIdempotencyKey, requestFingerprint } from "@/lib/idempotency";
import { createInsuranceClaimAtomically, InsurancePolicyInactiveError } from "@/lib/insurance-claim-atomic";

// Claim + policy status are one atomic business operation. Notifications are
// post-commit best-effort side effects and cannot change the claim result.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "بدنه درخواست معتبر نیست" }, { status: 400 });
  }

  const rawKey = readIdempotencyKey(req);
  if (!rawKey) {
    return NextResponse.json({ error: "هدر Idempotency-Key معتبر و الزامی است" }, { status: 400 });
  }

  const { policyId, jobId, description, amount } = body;
  if (typeof policyId !== "string" || !policyId) {
    return NextResponse.json({ error: "policyId الزامی است" }, { status: 400 });
  }
  if (typeof description !== "string" || description.trim().length < 5) {
    return NextResponse.json({ error: "توضیحات حداقل ۵ نویسه باشد" }, { status: 400 });
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "amount باید بیشتر از صفر باشد" }, { status: 400 });
  }

  const access = await requirePolicyOwner(session, policyId);
  if (access) return access;

  const db = await getDbForLib();
  const policy = await db.insurancePolicy.findUnique({
    where: { id: policyId },
    select: { id: true, userId: true, status: true },
  });
  if (!policy) return NextResponse.json({ error: "بیمه‌نامه یافت نشد" }, { status: 404 });
  if (policy.status === "expired" || policy.status === "cancelled") {
    return NextResponse.json({ error: "این بیمه‌نامه فعال نیست" }, { status: 400 });
  }

  let normalizedJobId: string | null = null;
  if (typeof jobId === "string" && jobId.trim()) {
    const job = await db.job.findUnique({
      where: { id: jobId.trim() },
      select: { request: { select: { customerId: true } }, technicianId: true },
    });
    if (!job) return NextResponse.json({ error: "کار موردنظر یافت نشد" }, { status: 404 });

    const customer = await db.customer.findUnique({ where: { userId: session.userId } });
    const technician = await db.technician.findUnique({ where: { userId: session.userId } });
    const isParticipant =
      session.role === "ADMIN" ||
      (customer && job.request.customerId === customer.id) ||
      (technician && job.technicianId === technician.id);
    if (!isParticipant) {
      return NextResponse.json({ error: "کار متعلق به این کاربر نیست" }, { status: 403 });
    }
    normalizedJobId = jobId.trim();
  }

  const normalized = {
    actorUserId: session.userId,
    policyId,
    jobId: normalizedJobId,
    description: description.trim().slice(0, 2000),
    amount,
  };
  const idempotencyKey = `insurance-claim:${session.userId}:${rawKey}`;
  const fingerprint = requestFingerprint(normalized);

  try {
    const result = await createInsuranceClaimAtomically(db, {
      ...normalized,
      idempotencyKey,
      requestFingerprint: fingerprint,
      code: `CLM-${crypto.randomUUID().toUpperCase()}`,
    });

    const claim = await db.insuranceClaim.findUnique({
      where: { idempotencyKey },
    });
    if (!claim) throw new Error("Insurance claim committed but could not be read back");

    if (result.created) {
      try {
        await db.notification.create({
          data: {
            userId: policy.userId,
            type: "insurance_claim",
            title: `Claim ${claim.code} submitted`,
            body: `Your claim for ${claim.amount} is under review.`,
            category: "system",
            link: "customer/insurance",
          },
        });
      } catch {
        // Notification failure is not a business-operation failure.
      }
    }

    return NextResponse.json({ ok: true, claim }, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof InsurancePolicyInactiveError) {
      return NextResponse.json({ error: "این بیمه‌نامه دیگر فعال نیست" }, { status: 409 });
    }
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json(
        { error: "این کلید قبلاً برای اطلاعات متفاوتی استفاده شده است" },
        { status: 409 }
      );
    }
    throw error;
  }
}
