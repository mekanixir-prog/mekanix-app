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
  const updated = await db.mechanicApplication.update({
    where: { id },
    data: { status: "REJECTED", reviewedAt: new Date(), adminNotes: body.notes || null },
  });
  return NextResponse.json(updated);
}
