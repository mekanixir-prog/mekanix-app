import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";
import { createMaintenanceRuleWithAudit } from "@/lib/admin-audit-atomic";

export async function GET(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;
  const rules = await db.maintenanceRule.findMany({ orderBy: { brand: "asc" } });
  return NextResponse.json(rules);
}

export async function POST(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;
  const body = await req.json();
  const rule = await createMaintenanceRuleWithAudit(db, { brand: body.brand, model: body.model || null, yearFrom: body.yearFrom ?? null, yearTo: body.yearTo ?? null, engine: body.engine ?? null, mileageInterval: body.mileageInterval ?? null, timeInterval: body.timeInterval ?? null, category: body.category, priority: body.priority || "REQUIRED", version: body.version || "1.0" }, { id: session.userId, role: session.role }, req);
  return NextResponse.json(rule);
}
