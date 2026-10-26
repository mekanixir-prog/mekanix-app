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
  const packages = await db.servicePackage.findMany({ include: { items: true }, orderBy: { order: "asc" } });
  return NextResponse.json(packages);
}

export async function POST(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const forbidden = requireRole(session, "ADMIN");
  if (forbidden) return forbidden;
  const body = await req.json();
  const pkg = await db.servicePackage.create({ data: { name: body.name, nameFa: body.nameFa || body.name, description: body.description, category: body.category || "periodic", basePrice: body.basePrice || 0, order: body.order || 0 } });
  return NextResponse.json(pkg);
}
