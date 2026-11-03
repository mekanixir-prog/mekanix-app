import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { assertIrrInteger } from "@/lib/money/irr";

async function ensureAssignedTechOrAdmin(session: any, jobId: string) {
  if (session.role === "ADMIN") return null;
  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }
  const tech = await getTechnicianFromSession(session);
  const db = await getDbForLib();
  const job = await db.job.findUnique({ where: { id: jobId }, select: { technicianId: true } });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
  if (!tech || tech.id !== job.technicianId) {
    return NextResponse.json(
      { error: "فقط مکانیک مسئول این کار مجاز است" },
      { status: 403 }
    );
  }
  return null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id: jobId } = await params;

  // BOLA: participant check + must be the assigned technician (or admin)
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;
  const techGuard = await ensureAssignedTechOrAdmin(session, jobId);
  if (techGuard) return techGuard;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "نام قطعه الزامی است" }, { status: 400 });
  }
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  const unitPrice = body.unitPrice === undefined ? 0 : body.unitPrice;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
    return NextResponse.json({ error: "تعداد باید عدد صحیح بین ۱ تا ۱۰۰۰ باشد" }, { status: 400 });
  }
  if (body.currency !== "IRR") {
    return NextResponse.json({ error: "واحد قیمت قطعه باید IRR باشد" }, { status: 400 });
  }
  try {
    assertIrrInteger(unitPrice, "Part unit price");
  } catch {
    return NextResponse.json({ error: "قیمت قطعه باید عدد صحیح و نامنفی به ریال باشد" }, { status: 400 });
  }

  const part = await (await getDbForLib()).part.create({
    data: {
      jobId,
      name: String(body.name).slice(0, 200),
      sku: typeof body.sku === "string" ? body.sku.slice(0, 100) : null,
      quantity,
      unitPrice,
    },
  });
  return NextResponse.json(part);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id: jobId } = await params;

  const access = await requireJobParticipant(session, jobId);
  if (access) return access;
  const techGuard = await ensureAssignedTechOrAdmin(session, jobId);
  if (techGuard) return techGuard;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.partId !== "string" || !body.partId) {
    return NextResponse.json({ error: "partId الزامی است" }, { status: 400 });
  }

  // Ensure the part actually belongs to this job (defense-in-depth)
  const db = await getDbForLib();
  const part = await db.part.findUnique({ where: { id: body.partId }, select: { jobId: true } });
  if (!part || part.jobId !== jobId) {
    return NextResponse.json({ error: "قطعه متعلق به این کار نیست" }, { status: 404 });
  }

  await db.part.delete({ where: { id: body.partId } });
  return NextResponse.json({ ok: true });
}
