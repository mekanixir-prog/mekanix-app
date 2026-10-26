import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

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
  const stats = {
    total: referrals.length,
    signedUp: referrals.filter((r) => r.status === "signed_up" || r.status === "first_job" || r.status === "rewarded").length,
    firstJob: referrals.filter((r) => r.status === "first_job" || r.status === "rewarded").length,
    earned: referrals.filter((r) => r.rewardClaimed).reduce((s, r) => s + Number(r.rewardAmount), 0),
    available: referrals.filter((r) => r.status === "first_job" && !r.rewardClaimed).reduce((s, r) => s + Number(r.rewardAmount), 0),
  };
  return NextResponse.json({ referrals, stats });
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

  if (referral.status !== "first_job" || referral.rewardClaimed) {
    return NextResponse.json({ error: "این پاداش قابل دریافت نیست" }, { status: 400 });
  }

  const updated = await db.referral.update({
    where: { id: referralId },
    data: { rewardClaimed: true, status: "rewarded", completedAt: new Date() },
  });

  // Notification — best-effort, never fail a reward claim over a notification.
  try {
    await db.notification.create({
      data: {
        userId: updated.referrerId,
        type: "referral_rewarded",
        title: "Referral reward claimed!",
        body: `You earned ${Number(updated.rewardAmount)} IRR from your referral.`,
        category: "system",
        link: "customer/referral",
      },
    });
  } catch (e) {
    console.error("[referral/claim] Failed to create notification (reward still claimed):", e);
  }
  return NextResponse.json({ ok: true, referral: updated });
}
