import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";

// Dedicated read endpoint: withdrawal requests are intentionally not exposed
// through the generic admin resource API.
export async function GET(req: Request) {
  const admin = await getAdminFromRequest(req);
  if (!admin) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const allowed = ["REQUESTED", "APPROVED", "PAID", "REJECTED", "REFUND_PENDING", "RECONCILIATION_NEEDED"];
  if (status && !allowed.includes(status)) {
    return NextResponse.json({ error: "وضعیت نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const requests = await db.withdrawalRequest.findMany({
    where: status
      ? { status: status as "REQUESTED" | "APPROVED" | "PAID" | "REJECTED" | "REFUND_PENDING" | "RECONCILIATION_NEEDED" }
      : undefined,
    include: { wallet: { include: { technician: { include: { user: true } } } } },
    orderBy: { requestedAt: "desc" },
    take: 100,
  });
  return NextResponse.json(requests);
}
