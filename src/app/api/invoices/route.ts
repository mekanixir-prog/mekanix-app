import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireJobParticipant, getTechnicianFromSession } from "@/lib/auth";

const FULL_INCLUDE = {
  job: {
    include: {
      request: { include: { customer: { include: { user: true } }, vehicle: true } },
      technician: { include: { user: true } },
      parts: true,
      diagnosisRecords: true,
    },
  },
  payment: true,
} as const;

// GET: returns invoice by jobId. Caller must be a participant in the job (BOLA).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return NextResponse.json(null);

  // Verify participation
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  const db = await getDbForLib();
  const inv = await db.invoice.findUnique({ where: { jobId }, include: FULL_INCLUDE });
  return NextResponse.json(inv);
}

// POST: creates an invoice. Only the technician assigned to the job (or admin) may issue it.
// Server-authoritative: prices are computed from technician's rates + parts, NOT from client.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { jobId } = body;
  if (typeof jobId !== "string" || !jobId) {
    return NextResponse.json({ error: "jobId الزامی است" }, { status: 400 });
  }

  // BOLA: must be participant (customer OR assigned tech) OR admin to even read this job
  const access = await requireJobParticipant(session, jobId);
  if (access) return access;

  // Only the assigned technician (or admin) can issue an invoice
  const db = await getDbForLib();
  if (session.role === "TECHNICIAN") {
    const tech = await getTechnicianFromSession(session);
    const job = await db.job.findUnique({ where: { id: jobId }, select: { technicianId: true } });
    if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });
    if (!tech || tech.id !== job.technicianId) {
      return NextResponse.json(
        { error: "فقط مکانیک مسئول کار می‌تواند فاکتور صادر کند" },
        { status: 403 }
      );
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  // ──────────── Server-authoritative pricing ────────────
  // Load job + parts + technician rates — IGNORE any client-supplied amounts.
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { parts: true, technician: true },
  });
  if (!job) return NextResponse.json({ error: "کار یافت نشد" }, { status: 404 });

  // laborHours may be overridden by technician (capped 0–100); everything else is server-derived.
  const laborHoursRaw = typeof body.laborHours === "number" ? body.laborHours : 1.5;
  const laborHours = Math.max(0, Math.min(100, laborHoursRaw));

  const laborRate = Number(job.technician.hourlyRate); // from technician record
  const laborTotal = laborHours * laborRate;
  const partsTotal = job.parts.reduce((s, p) => s + Number(p.unitPrice) * p.quantity, 0);
  const travelFee = Number(job.technician.travelFeeBase);
  const discount = 0; // server-controlled
  const subtotal = laborTotal + partsTotal + travelFee - discount;
  const taxSetting = await db.platformSetting.findUnique({ where: { key: "tax_rate" } });
    const taxRate = taxSetting?.value ? parseFloat(taxSetting.value) : 0.09;
  const taxTotal = subtotal * taxRate;
  const total = subtotal + taxTotal;

  const code = `INV-${Math.floor(3000 + Math.random() * 6000)}`;

  const inv = await db.invoice.create({
    data: {
      code,
      jobId,
      laborHours,
      laborRate,
      laborTotal,
      partsTotal,
      travelFee,
      discount,
      subtotal,
      taxRate,
      taxTotal,
      total,
      currency: "USD",
      status: "SENT",
      notes: "Parts & labor covered by 6-month MEKANIX warranty.",
    },
    include: FULL_INCLUDE,
  });

  // Notify BOTH the customer and the mechanic that the invoice was issued.
  const refreshed = await db.job.findUnique({
    where: { id: jobId },
    include: {
      request: { include: { customer: { include: { user: true } } } },
      technician: { include: { user: true } },
    },
  });
  if (refreshed) {
    const cust = refreshed.request.customer.user;
    const tech = refreshed.technician?.user;
    await db.notification.create({
      data: {
        userId: cust.id,
        type: "invoice_issued",
        title: `Invoice ${inv.code} issued`,
        body: `${tech?.name ?? "Mechanic"} issued invoice for ${Number(inv.total)}. Review and pay to complete the job.`,
        category: "payment",
        link: "customer/invoice",
      },
    });
    if (tech) {
      await db.notification.create({
        data: {
          userId: tech.id,
          type: "invoice_issued",
          title: `Invoice ${inv.code} sent to customer`,
          body: `${inv.code} for ${Number(inv.total)} was sent to ${cust.name} for review & payment.`,
          category: "payment",
          link: "technician/earnings",
        },
      });
    }
    await db.message.create({
      data: {
        jobId: refreshed.id,
        fromUserId: tech?.id ?? cust.id,
        kind: "system",
        body: `Invoice ${inv.code} issued — total ${Number(inv.total)} ${inv.currency}.`,
      },
    });
  }
  return NextResponse.json(inv);
}
