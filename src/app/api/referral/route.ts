import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { isSafeStoredIrrAmount, maskFinancialFields, sumSafeStoredIrrAmounts } from "@/lib/money/financial-read-mask";

// GET: list user's referrals + stats.
// referrerId is derived from the session — the `userId` query param is IGNORED (BOLA protection).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const userId = session.userId;
  const db = await getDbForLib();

  const referrals = await db.referral.findMany({
    where: { referrerId: userId },
    orderBy: { createdAt: "desc" },
    include: { referredUser: true },
  });
  const allRewardsVerified = referrals.every((referral) => referral.financialUnitStatus === "VERIFIED_IRR" && isSafeStoredIrrAmount(referral.rewardAmount));
  const safeReferrals = referrals.map((referral) => maskFinancialFields(referral, ["rewardAmount"]));
  const earned = allRewardsVerified
    ? sumSafeStoredIrrAmounts(referrals.filter((r) => r.rewardClaimed).map((r) => r.rewardAmount))
    : null;
  const available = allRewardsVerified
    ? sumSafeStoredIrrAmounts(referrals.filter((r) => r.status === "first_job" && !r.rewardClaimed).map((r) => r.rewardAmount))
    : null;
  const stats = {
    total: referrals.length,
    signedUp: referrals.filter((r) => r.status === "signed_up" || r.status === "first_job" || r.status === "rewarded").length,
    firstJob: referrals.filter((r) => r.status === "first_job" || r.status === "rewarded").length,
    earned,
    available,
  };
  return NextResponse.json({ referrals: safeReferrals, stats });
}

// POST: get-or-create a referral code for the authenticated user.
// referrerId is derived from the session — NEVER from request body.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const userId = session.userId;
  const db = await getDbForLib();

  // Check if user already has a referral code
  const existing = await db.referral.findFirst({ where: { referrerId: userId } });
  if (existing) return NextResponse.json({ code: existing.code });

  // Generate a unique code based on user's phone/name
  const user = await db.user.findUnique({ where: { id: userId } });
  const prefix = user?.name?.slice(0, 3).toUpperCase() ?? "MEK";
  const code = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  const referral = await db.referral.create({
    data: { code, referrerId: userId, status: "pending" },
  });
  return NextResponse.json({ code: referral.code });
}

// PATCH: claim a reward. The referralId must belong to the authenticated user (referrer).
// Prevents self-referral: the referrer and referredUser must be different.
export async function PATCH(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { referralId, action } = body;
  if (action !== "claim" || typeof referralId !== "string" || !referralId) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const db = await getDbForLib();

  // BOLA: the referral must belong to this user (as the referrer)
  const referral = await db.referral.findUnique({ where: { id: referralId } });
  if (!referral) return NextResponse.json({ error: "Referral not found" }, { status: 404 });
  if (referral.referrerId !== session.userId) {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // Self-referral prevention
  if (referral.referredUserId && referral.referredUserId === session.userId) {
    return NextResponse.json({ error: "ارجاع به خود مجاز نیست" }, { status: 400 });
  }

  if (referral.financialUnitStatus !== "VERIFIED_IRR" || !isSafeStoredIrrAmount(referral.rewardAmount)) {
    return NextResponse.json({ error: "منشأ مالی پاداش ارجاع تأیید نشده است", code: "REFERRAL_REWARD_PROVENANCE_UNVERIFIED" }, { status: 409 });
  }

  if (referral.status !== "first_job" || referral.rewardClaimed) {
    return NextResponse.json({ error: "این پاداش قابل دریافت نیست" }, { status: 400 });
  }

  // Claiming a reward without atomically crediting the verified wallet and
  // writing its immutable ledger entry would falsely report a settlement.
  // Keep this mutation closed until the owner approves the accounting contract
  // and the Prisma/D1 atomic settlement implementation is available.
  return NextResponse.json(
    {
      error: "تسویهٔ پاداش معرفی هنوز آماده نیست؛ تا تکمیل ثبت اتمیک اعتبار کیف پول، امکان دریافت وجود ندارد",
      code: "REFERRAL_REWARD_SETTLEMENT_NOT_IMPLEMENTED",
    },
    { status: 409 },
  );

  // Compare-and-set prevents two concurrent claim requests from both
  // reporting success for the same reward.
  const claimed = await db.referral.updateMany({
    where: {
      id: referralId,
      referrerId: session.userId,
      status: "first_job",
      rewardClaimed: false,
      financialUnitStatus: "VERIFIED_IRR",
    },
    data: { rewardClaimed: true, status: "rewarded", completedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "این پاداش هم‌زمان دریافت شده یا دیگر قابل دریافت نیست" }, { status: 409 });
  }
  const updated = await db.referral.findUnique({ where: { id: referralId } });
  if (!updated) {
    return NextResponse.json({ error: "وضعیت دریافت پاداش نیازمند بررسی است" }, { status: 409 });
  }

  // Notification — best-effort, never fail a reward claim over a notification.
  try {
    await db.notification.create({
      data: {
        userId: updated.referrerId,
        type: "referral_rewarded",
        title: "Referral reward claimed!",
        body: `Your referral reward ${updated.code} has been claimed.`,
        category: "system",
        link: "customer/referral",
      },
    });
  } catch (e) {
    console.error("[referral/claim] Failed to create notification (reward still claimed):", e);
  }
  return NextResponse.json({ ok: true, referral: maskFinancialFields(updated, ["rewardAmount"]) });
}
