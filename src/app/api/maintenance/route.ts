import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { sanitizeInput, ALLOWED_FIELDS, requireVehicleOwner } from "@/lib/auth";

// GET: list maintenance schedules for the authenticated user's vehicles (or one vehicle).
// customerId query param is IGNORED — derived from session (BOLA protection).
export async function GET(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  const url = new URL(req.url);
  const vehicleId = url.searchParams.get("vehicleId");
  const db = await getDbForLib();

  const where: any = {};
  if (session.role === "CUSTOMER") {
    const customer = await db.customer.findUnique({ where: { userId: session.userId } });
    if (!customer) return NextResponse.json([]);
    if (vehicleId) {
      // BOLA: vehicle must belong to this customer
      const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { customerId: true } });
      if (!vehicle || vehicle.customerId !== customer.id) {
        return NextResponse.json({ error: "دسترسی به این خودرو مجاز نیست" }, { status: 403 });
      }
      where.vehicleId = vehicleId;
    } else {
      where.vehicle = { customerId: customer.id };
    }
  } else if (session.role === "TECHNICIAN") {
    // Technicians see schedules for vehicles in jobs they're assigned to
    const tech = await db.technician.findUnique({ where: { userId: session.userId } });
    if (!tech) return NextResponse.json([]);
    where.vehicle = {
      serviceRequests: { some: { job: { technicianId: tech.id } } },
    };
  }
  // ADMIN sees all (no filter)

  const schedules = await db.maintenanceSchedule.findMany({
    where,
    orderBy: { nextDueDate: "asc" },
    include: { vehicle: true },
  });
  return NextResponse.json(schedules);
}

// POST: create a new maintenance schedule for a vehicle owned by the caller.
export async function POST(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const safe = sanitizeInput(body, ALLOWED_FIELDS.maintenance);
  if (!safe.vehicleId || !safe.category || !safe.title) {
    return NextResponse.json({ error: "vehicleId, category, and title are required" }, { status: 400 });
  }

  // BOLA: caller must own the vehicle (or be admin)
  const ownership = await requireVehicleOwner(session, safe.vehicleId);
  if (ownership) return ownership;

  // Compute nextDueDate based on intervalDays from now
  let nextDueDate: Date | null = null;
  if (typeof safe.intervalDays === "number" && safe.intervalDays > 0) {
    nextDueDate = new Date(Date.now() + safe.intervalDays * 24 * 60 * 60 * 1000);
  }

  const db = await getDbForLib();
  const schedule = await db.maintenanceSchedule.create({
    data: {
      vehicleId: safe.vehicleId,
      category: String(safe.category).slice(0, 50),
      title: String(safe.title).slice(0, 200).trim(),
      intervalKm: typeof safe.intervalKm === "number" ? safe.intervalKm : null,
      intervalHours: typeof safe.intervalHours === "number" ? safe.intervalHours : null,
      intervalDays: typeof safe.intervalDays === "number" ? safe.intervalDays : null,
      nextDueDate,
      notes: typeof safe.notes === "string" ? safe.notes.slice(0, 1000) : null,
    },
    include: { vehicle: true },
  });
  return NextResponse.json(schedule);
}

// PATCH: mark a schedule as done (resets lastDone, computes nextDue).
// The schedule's vehicle must be owned by the caller.
export async function PATCH(req: Request) {
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, action } = body;
  if (typeof id !== "string" || !id || action !== "markDone") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const db = await getDbForLib();

  const existing = await db.maintenanceSchedule.findUnique({
    where: { id },
    select: { id: true, vehicleId: true, intervalDays: true },
  });
  if (!existing) return NextResponse.json({ error: "Schedule not found" }, { status: 404 });

  // BOLA: caller must own the vehicle tied to this schedule (or admin)
  const ownership = await requireVehicleOwner(session, existing.vehicleId);
  if (ownership) return ownership;

  const now = new Date();
  let nextDueDate: Date | null = null;
  if (existing.intervalDays) {
    nextDueDate = new Date(now.getTime() + existing.intervalDays * 24 * 60 * 60 * 1000);
  }
  const updated = await db.maintenanceSchedule.update({
    where: { id },
    data: {
      lastDoneDate: now,
      nextDueDate,
    },
    include: { vehicle: true },
  });
  return NextResponse.json(updated);
}
