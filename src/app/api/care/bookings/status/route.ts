import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

// GET /api/care/bookings/status?key=...
// Read-only proof used by the offline reconciliation center. A booking row
// alone is not enough: its frozen pricing snapshot and creation event must
// also be present and linked to the same booking.
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const key = new URL(req.url).searchParams.get("key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return NextResponse.json({ error: "کلید رزرو نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const booking = await db.serviceBooking.findUnique({
    where: { idempotencyKey: key },
    select: {
      id: true,
      code: true,
      userId: true,
      requestFingerprint: true,
      pricingSnapshotId: true,
    },
  });

  if (!booking) {
    return NextResponse.json({ state: "NOT_COMMITTED", retryAllowed: true });
  }
  if (booking.userId !== session.userId) {
    return NextResponse.json({ state: "KEY_CONFLICT" }, { status: 409 });
  }

  const [snapshot, event] = await Promise.all([
    db.pricingSnapshot.findUnique({
      where: { bookingId: booking.id },
      select: { id: true, bookingId: true },
    }),
    db.serviceTimelineEvent.findUnique({
      where: { idempotencyKey: `care-booking:${key}:created` },
      select: { id: true, bookingId: true },
    }),
  ]);

  if (
    !snapshot ||
    snapshot.bookingId !== booking.id ||
    snapshot.id !== booking.pricingSnapshotId ||
    !event ||
    event.bookingId !== booking.id
  ) {
    return NextResponse.json(
      { state: "RECONCILIATION_REQUIRED", bookingCode: booking.code },
      { status: 409 }
    );
  }

  return NextResponse.json({
    state: "COMMITTED",
    booking: { id: booking.id, code: booking.code },
  });
}
