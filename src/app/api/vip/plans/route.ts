import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// List all active VIP plans (sorted by order) — public, no auth required.
export async function GET() {
  const db = await getDbForLib();
  const plans = await db.vipPlan.findMany({
    where: { active: true },
    orderBy: { order: "asc" },
    include: { subscriptions: false },
  });
  return NextResponse.json(plans);
}
