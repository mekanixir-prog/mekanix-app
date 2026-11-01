import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// A claim is COMMITTED only when both the claim and its policy state agree.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const rawKey = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(rawKey)) {
    return NextResponse.json({ error: "کلید خسارت نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const idempotencyKey = `insurance-claim:${session.userId}:${rawKey}`;
  const claim = await db.insuranceClaim.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      code: true,
      policyId: true,
      policy: { select: { userId: true, status: true } },
    },
  });

  if (!claim) {
    return NextResponse.json({ state: "NOT_COMMITTED", retryAllowed: true });
  }

  if (session.role !== "ADMIN" && claim.policy.userId !== session.userId) {
    return NextResponse.json({ state: "KEY_CONFLICT" }, { status: 409 });
  }

  if (claim.policy.status !== "claimed") {
    return NextResponse.json(
      { state: "RECONCILIATION_REQUIRED", claimCode: claim.code, policyStatus: claim.policy.status },
      { status: 409 }
    );
  }

  return NextResponse.json({
    state: "COMMITTED",
    claim: { id: claim.id, code: claim.code, policyId: claim.policyId },
  });
}
