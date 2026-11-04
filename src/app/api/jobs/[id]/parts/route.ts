import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";
import { getJobPartAmountError } from "@/lib/money/job-part-amount";

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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "نام قطعه الزامی است" }, { status: 400 });
  }

  const amountError = getJobPartAmountError(body.quantity, body.unitPrice);
  if (amountError === "PART_QUANTITY_MUST_BE_POSITIVE_INTEGER") {
    return NextResponse.json({ error: "تعداد قطعه باید عدد صحیح مثبت باشد", code: amountError }, { status: 400 });
  }
  if (amountError === "PART_UNIT_PRICE_MUST_BE_NON_NEGATIVE_INTEGER_IRR") {
    return NextResponse.json({ error: "قیمت واحد قطعه باید عدد صحیح نامنفی به ریال باشد", code: amountError }, { status: 400 });
  }

  const part = await (await getDbForLib()).part.create({
    data: {
      jobId,
      name: body.name.trim().slice(0, 200),
      sku: typeof body.sku === "string" ? body.sku.slice(0, 100) : null,
      quantity: body.quantity,
      unitPrice: body.unitPrice,
      financialUnitStatus: "VERIFIED_IRR",
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
