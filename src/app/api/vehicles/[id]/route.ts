import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth, validateBody } from "@/lib/api-helpers";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";
import { vehicleUpdateSchema } from "@/lib/schemas/vehicle";
import {
  requireVehicleOwner,
  sanitizeInput,
  ALLOWED_FIELDS,
} from "@/lib/auth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const ownership = await requireVehicleOwner(session, id);
  if (ownership) return ownership;

  const db = await getDbForLib();
  await db.vehicle.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const ownership = await requireVehicleOwner(session, id);
  if (ownership) return ownership;

  const body = await validateBody(req, vehicleUpdateSchema);
  if (!body.ok) return body.response;

  // Mass-assignment protection — only allow whitelisted vehicle fields.
  // customerId is server-authoritative and is never overridden.
  const safe = sanitizeInput(body.data as unknown as Record<string, any>, ALLOWED_FIELDS.vehicle);

  // Validate the resulting record, not just the submitted fragment: a PATCH
  // that changes only the make must still respect the existing asset type.
  const db = await getDbForLib();
  const current = await db.vehicle.findUnique({ where: { id }, select: { type: true, make: true } });
  if (!current) return NextResponse.json({ error: "وسیله یافت نشد" }, { status: 404 });
  const nextType = safe.type ?? current.type;
  const nextMake = safe.make ?? current.make;
  if (!isVehicleInSupportedScope(nextType, nextMake)) {
    return NextResponse.json({ error: "این وسیله یا برند در محدوده خدمات و نرخ‌نامه تأییدشده MEKANIX نیست", code: "VEHICLE_OUT_OF_SCOPE" }, { status: 400 });
  }
  const vehicle = await db.vehicle.update({ where: { id }, data: safe as any });
  return NextResponse.json(vehicle);
}
