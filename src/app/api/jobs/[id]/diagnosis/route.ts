import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const access = await requireJobParticipant(session, id);
  if (access) return access;

  const db = await getDbForLib();

  // Only the technician assigned to this job (or admin) can set diagnosis.
  if (session.role === "TECHNICIAN") {
    const tech = await getTechnicianFromSession(session);
    const job = await db.job.findUnique({ where: { id }, select: { technicianId: true } });
    if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
    if (!tech || tech.id !== job.technicianId) {
      return NextResponse.json(
        { error: "فقط مکانیک مسئول این کار می‌تواند تشخیص ثبت کند" },
        { status: 403 }
      );
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.diagnosis !== "string" || !body.diagnosis.trim()) {
    return NextResponse.json({ error: "diagnosis الزامی است" }, { status: 400 });
  }

  const job = await db.job.update({
    where: { id },
    data: {
      diagnosis: body.diagnosis,
      technicianNotes: typeof body.technicianNotes === "string" ? body.technicianNotes : undefined,
    },
  });
  if (body.severity || body.faultCode) {
    await db.diagnosis.create({
      data: {
        jobId: id,
        summary: body.diagnosis,
        severity: typeof body.severity === "string" ? body.severity : "medium",
        faultCode: typeof body.faultCode === "string" ? body.faultCode : null,
      },
    });
  }
  const fresh = await db.job.findUnique({
    where: { id },
    include: {
      request: { include: { customer: { include: { user: true } }, vehicle: true } },
      technician: { include: { user: true } },
      parts: true,
      diagnosisRecords: true,
      invoice: true,
      reviews: true,
      messages: { include: { fromUser: true } },
      tracking: true,
    },
  });
  return NextResponse.json(fresh);
}
