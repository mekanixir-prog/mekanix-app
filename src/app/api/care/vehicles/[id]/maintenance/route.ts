import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { requireVehicleOwner } from "@/lib/auth";

// GET /api/care/vehicles/[id]/maintenance — next service + recommendations
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;
  const { id: vehicleId } = await ctx.params;

  const access = await requireVehicleOwner(session, vehicleId);
  if (access) return access;

  // Get vehicle care profile
  const careProfile = await db.vehicleCareProfile.findUnique({ where: { vehicleId } });
  const vehicle = await db.vehicle.findUnique({ where: { id: vehicleId } });

  if (!vehicle) return NextResponse.json({ error: "خودرو یافت نشد" }, { status: 404 });

  const currentMileage = careProfile?.currentMileage ?? vehicle.engineHours ?? 0;

  // Get maintenance schedule items
  const scheduleItems = await db.maintenanceScheduleItem.findMany({
    where: { vehicleId, status: { in: ["UPCOMING", "DUE", "OVERDUE"] } },
    orderBy: [{ dueMileage: "asc" }, { dueDate: "asc" }],
  });

  // Get maintenance rules for this vehicle
  const rules = await db.maintenanceRule.findMany({
    where: {
      brand: vehicle.make,
      active: true,
    },
  });

  // Calculate next services based on rules
  const recommendations = rules.map(rule => {
    const dueMileage = rule.mileageInterval 
      ? Math.ceil(currentMileage / rule.mileageInterval) * rule.mileageInterval
      : null;
    const kmRemaining = dueMileage ? dueMileage - currentMileage : null;
    
    return {
      category: rule.category,
      priority: rule.priority,
      dueMileage,
      kmRemaining,
      version: rule.version,
    };
  });

  // Get health report
  const healthReport = await db.vehicleHealthReport.findFirst({
    where: { vehicleId },
    orderBy: { createdAt: "desc" },
  });

  // Get service history (bookings)
  const history = await db.serviceBooking.findMany({
    where: { vehicleId, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  // Get reminders
  const reminders = await db.careReminder.findMany({
    where: { vehicleId, status: "ACTIVE" },
    orderBy: { dueDate: "asc" },
  });

  return NextResponse.json({
    vehicle: {
      id: vehicle.id,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      currentMileage,
    },
    healthScore: careProfile?.healthScore ?? 100,
    nextService: scheduleItems[0] || recommendations[0] || null,
    scheduleItems,
    recommendations,
    healthReport,
    recentServices: history,
    reminders,
  });
}
