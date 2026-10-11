import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";

const include = {
  request: { include: { customer: { include: { user: true } }, vehicle: true } },
  technician: { include: { user: true, specialties: true } },
  parts: true,
  diagnosisRecords: true,
  invoice: true,
  reviews: true,
  messages: { include: { fromUser: true }, orderBy: { createdAt: "asc" } },
  tracking: { orderBy: { ts: "asc" } },
} as const;

// POST /api/service-requests/[id]/assign
// Customer (owner of the request) accepts a matched technician → creates a Job in REQUESTED state.
// - Request must belong to the calling customer (or be admin).
// - technicianId is required in body (chosen by the customer).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { technicianId } = body;
  if (typeof technicianId !== "string" || !technicianId) {
    return NextResponse.json({ error: "technicianId الزامی است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const sr = await db.serviceRequest.findUnique({ where: { id }, include: { vehicle: true } });
  if (!sr) return NextResponse.json({ error: "درخواست یافت نشد" }, { status: 404 });

  // BOLA: customer must own the request, or be admin
  if (session.role === "CUSTOMER") {
    // Look up the customer profile for this user
    const customer = await db.customer.findUnique({ where: { userId: session.userId } });
    if (!customer || sr.customerId !== customer.id) {
      return NextResponse.json({ error: "شما مالک این درخواست نیستید" }, { status: 403 });
    }
  } else if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "دسترسی مجاز نیست" }, { status: 403 });
  }

  const tech = await db.technician.findUnique({ where: { id: technicianId } });
  if (!tech) return NextResponse.json({ error: "مکانیک یافت نشد" }, { status: 404 });

  // compute ETA from distance
  const km = tech.lat && tech.lng && sr.lat
    ? (() => {
        const R = 6371;
        const dLat = ((sr.lat - tech.lat) * Math.PI) / 180;
        const dLng = ((sr.lng - tech.lng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((tech.lat * Math.PI) / 180) * Math.cos((sr.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      })()
    : 10;
  const etaMins = Math.max(5, Math.round((km / 35) * 60) + tech.responseMins);

  await db.serviceRequest.update({ where: { id }, data: { status: "ASSIGNED", matchedTechId: technicianId } });

  const job = await db.job.create({
    data: {
      code: `JOB-${Math.floor(4000 + Math.random() * 5000)}`,
      requestId: id,
      technicianId,
      status: "REQUESTED",
      etaMins,
    },
    include,
  });

  // Notify the technician
  await db.notification.create({
    data: {
      userId: tech.userId,
      type: "new_request",
      title: "New job assigned",
      body: `${job.code} — ${sr.title}. ETA to customer ${etaMins} min.`,
      category: "job",
      link: "technician/requests",
    },
  });

  return NextResponse.json(job);
}
