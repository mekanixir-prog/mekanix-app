import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getCustomerFromSession } from "@/lib/auth";
import { readIdempotencyKey } from "@/lib/idempotency";

// Read-only proof used by offline reconciliation. A request is committed only
// when its required vehicle relation exists and belongs to the same customer.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const rawKey = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(rawKey)) {
    return NextResponse.json({ error: "کلید درخواست نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const idempotencyKey = `service-request:${session.userId}:${rawKey}`;
  const request = await db.serviceRequest.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      code: true,
      customerId: true,
      vehicleId: true,
      vehicle: { select: { id: true, customerId: true } },
    },
  });

  if (!request) {
    return NextResponse.json({ state: "NOT_COMMITTED", retryAllowed: true });
  }

  if (session.role !== "ADMIN") {
    const customer = await getCustomerFromSession(session);
    if (!customer || customer.id !== request.customerId) {
      return NextResponse.json({ state: "KEY_CONFLICT" }, { status: 409 });
    }
  }

  if (!request.vehicle || request.vehicle.id !== request.vehicleId ||
      request.vehicle.customerId !== request.customerId) {
    return NextResponse.json(
      { state: "RECONCILIATION_REQUIRED", requestCode: request.code },
      { status: 409 }
    );
  }

  return NextResponse.json({
    state: "COMMITTED",
    request: { id: request.id, code: request.code },
  });
}
