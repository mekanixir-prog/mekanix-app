import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifySession, requireRole } from "@/lib/auth";
import { finalizeMechanicRejectionWithAudit, writeMechanicReviewClaimAudit } from "@/lib/admin-audit-atomic";

// POST /api/mechanic-applications/[id]/reject — ADMIN ONLY.
//
// Rejection claims PENDING -> REJECTING before finalizing. The approval route
// uses the competing PENDING -> APPROVING transition, so only one decision can
// win. REJECTING is resumable if a request is interrupted before finalization.
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
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 2000) : null;
  const db = await getDbForLib();

  let app = await db.mechanicApplication.findUnique({ where: { id } });
  if (!app) return NextResponse.json({ error: "Application not found" }, { status: 404 });

  if (app.status === "REJECTED") {
    // A retry after the original response was lost is an idempotent success.
    return NextResponse.json(app);
  }

  if (app.status === "PENDING") {
    const claimCount = await writeMechanicReviewClaimAudit(db, {
      applicationId: id,
      expectedStatus: "PENDING",
      nextStatus: "REJECTING",
      actor: { id: session.userId, role: session.role },
      req,
    });
    if (claimCount !== 1) {
      app = await db.mechanicApplication.findUnique({ where: { id } });
      if (!app || app.status !== "REJECTING") {
        return NextResponse.json(
          { error: "Application review was claimed by another decision", status: app?.status ?? "MISSING" },
          { status: 409 }
        );
      }
    }
  } else if (app.status !== "REJECTING") {
    return NextResponse.json(
      { error: "Application cannot be rejected from its current state", status: app.status },
      { status: 409 }
    );
  }

  const finalized = await finalizeMechanicRejectionWithAudit(db, {
    applicationId: id,
    actor: { id: session.userId, role: session.role },
    req,
    notes,
  });
  if (!finalized.ok) {
    app = await db.mechanicApplication.findUnique({ where: { id } });
    return NextResponse.json(
      { error: "Application rejection could not be finalized", status: app?.status ?? "MISSING" },
      { status: 409 }
    );
  }

  const updated = await db.mechanicApplication.findUnique({ where: { id } });
  return NextResponse.json(updated);
}
