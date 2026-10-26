import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireRole } from "@/lib/auth";

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
  const rule = await db.maintenanceRule.create({ data: { brand: body.brand, model: body.model || null, yearFrom: body.yearFrom, yearTo: body.yearTo, engine: body.engine, mileageInterval: body.mileageInterval, timeInterval: body.timeInterval, category: body.category, priority: body.priority || "REQUIRED", version: body.version || "1.0" } });
  return NextResponse.json(rule);
}
