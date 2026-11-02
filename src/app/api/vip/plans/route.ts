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
  const priceCurrencyVerified =
    process.env.MEKANIX_VIP_PLAN_PRICES_IRR_VERIFIED === "true";
  return NextResponse.json(plans.map((plan) => ({
    ...plan,
    priceIrr: priceCurrencyVerified ? Number(plan.priceIrr) : null,
    priceCurrencyVerified,
  })));
}
