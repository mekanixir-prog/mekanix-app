import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requirePolicyOwner } from "@/lib/auth";

// POST /api/insurance/claim
// File a new insurance claim against a policy.
// - policyId must be owned by the calling user (BOLA).
// - amount/description validated.
//
// Multi-step write (no $transaction in D1 — sequential):
//   1. insuranceClaim.create   (primary — the claim record)
//   2. insurancePolicy.update  (marks policy status → "claimed")
//   3. notification.create     (best-effort side-effect, wrapped in try/catch)
//
// Mid-failure behavior:
//   - If step 1 fails → 500, no partial state.
//   - If step 2 fails after step 1 → claim exists but policy still "active".
//     We log + still return success (the claim WAS created). The policy status
//     can be reconciled later by an admin/job. Failing the response here would
//     mislead the user (they'd think the claim failed, but it already exists).
//   - If step 3 fails → claim + policy updated, notification silently skipped.
//     Notifications are a side-effect, never a reason to fail the request.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { policyId, jobId, description, amount } = body;
  if (typeof policyId !== "string" || !policyId) {
    return NextResponse.json({ error: "policyId الزامی است" }, { status: 400 });
  }
  if (typeof description !== "string" || description.trim().length < 5) {
    return NextResponse.json({ error: "توضیحات حداقل ۵ نویسه باشد" }, { status: 400 });
  }
  if (typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "amount باید بیشتر از صفر باشد" }, { status: 400 });
  }

  // BOLA: must own the policy (or be admin)
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

  // If jobId is provided, ensure it's a job the user participates in
  if (jobId) {
    const job = await db.job.findUnique({
      where: { id: jobId },
      select: { request: { select: { customerId: true } }, technicianId: true },
    });
    if (job) {
      const customer = await db.customer.findUnique({ where: { userId: session.userId } });
      const technician = await db.technician.findUnique({ where: { userId: session.userId } });
      const isOwner =
        session.role === "ADMIN" ||
        (customer && job.request.customerId === customer.id) ||
        (technician && job.technicianId === technician.id);
      if (!isOwner) {
        return NextResponse.json({ error: "کار متعلق به این کاربر نیست" }, { status: 403 });
      }
    }
  }

  const code = `CLM-${Math.floor(7000 + Math.random() * 2000)}`;
  const claim = await db.insuranceClaim.create({
    data: {
      code,
      policyId,
      jobId: typeof jobId === "string" && jobId ? jobId : null,
      description: description.trim().slice(0, 2000),
      amount,
      status: "submitted",
    },
  });

  // Update policy status to "claimed" — best-effort after the claim is created.
  // If this fails the claim still exists; we log but don't fail the response.
  try {
    await db.insurancePolicy.update({
      where: { id: policyId },
      data: { status: "claimed" },
    });
  } catch (e) {
    console.error("[insurance/claim] Failed to update policy status to 'claimed' (claim still created):", e);
  }

  // Notify user + admins — best-effort, never fail the request over a notification.
  try {
    await db.notification.create({
      data: {
        userId: policy.userId,
        type: "insurance_claim",
        title: `Claim ${code} submitted`,
        body: `Your claim for ${claim.amount} is under review.`,
        category: "system",
        link: "customer/insurance",
      },
    });
  } catch (e) {
    console.error("[insurance/claim] Failed to create notification (claim still created):", e);
  }
  return NextResponse.json({ ok: true, claim });
}
