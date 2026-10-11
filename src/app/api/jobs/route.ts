import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getCustomerFromSession, getTechnicianFromSession } from "@/lib/auth";
import { wantsLite, liteResponse } from "@/lib/lite-response";

const include = {
  request: { include: { customer: { include: { user: true } }, vehicle: true } },
  technician: { include: { user: true, specialties: true } },
  parts: true,
  diagnosisRecords: true,
  invoice: true,
  reviews: true,
  messages: { include: { fromUser: true }, orderBy: { createdAt: "asc" } },
  tracking: { orderBy: { ts: "asc" } },
} as const;

export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  const where: any = {};
  if (status) where.status = status;

  // BOLA protection: derive customer/technician from session, NEVER from query
  if (session.role === "CUSTOMER") {
    const customer = await getCustomerFromSession(session);
    if (!customer) return NextResponse.json({ error: "پروفایل مشتری یافت نشد" }, { status: 403 });
    where.request = { customerId: customer.id };
  } else if (session.role === "TECHNICIAN") {
    const technician = await getTechnicianFromSession(session);
    if (!technician) return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
    where.technicianId = technician.id;
  }
  // ADMIN: no filter — sees all jobs

  const db = await getDbForLib();
  const list = await db.job.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include,
  });
  const lite = wantsLite(req);
  return NextResponse.json(liteResponse(list, lite));
}
