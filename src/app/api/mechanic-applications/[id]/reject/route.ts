import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifySession, requireRole } from "@/lib/auth";

// POST /api/mechanic-applications/[id]/reject — ADMIN ONLY.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = await verifySession(auth.slice(7));
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const db = await getDbForLib();
  // A rejection is valid only while the application is pending. The
  // compare-and-set prevents a second review from overwriting an approval or
  // an earlier rejection.
  const transition = await db.mechanicApplication.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "REJECTED", reviewedAt: new Date(), adminNotes: body.notes || null },
  });
  if (transition.count !== 1) {
    const current = await db.mechanicApplication.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!current) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "این درخواست قبلاً بررسی شده است", status: current.status },
      { status: 409 },
    );
  }

  const updated = await db.mechanicApplication.findUnique({ where: { id } });
  if (!updated) return NextResponse.json({ error: "Application not found" }, { status: 404 });
  return NextResponse.json(updated);
}
