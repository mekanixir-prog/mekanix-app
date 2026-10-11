// MEKANIX CARE — List missions for the authenticated technician
// BOLA: ADMIN sees all; TECHNICIAN sees only bookings assigned to their Technician profile;
// CUSTOMER gets 403.
//
// IMPORTANT: ServiceBooking.technicianId references Technician.id (NOT User.id).
// We must resolve the Technician record via getTechnicianFromSession before filtering.
import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { requireAuth } from "@/lib/api-helpers";
import { getTechnicianFromSession } from "@/lib/auth";

export async function GET(req: Request) {
  const db = await getDbForLib();
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  if (session.role !== "TECHNICIAN" && session.role !== "ADMIN") {
    return NextResponse.json(
      { error: "این بخش فقط برای مکانیک‌ها قابل دسترسی است" },
      { status: 403 }
    );
  }

  // Resolve the technician profile — ServiceBooking.technicianId references Technician.id,
  // not User.id, so filtering by session.userId directly is a BOLA/data-correctness bug.
  let technicianId: string | undefined;
  if (session.role === "TECHNICIAN") {
    const technician = await getTechnicianFromSession(session);
    if (!technician) {
      return NextResponse.json(
        { error: "پروفایل مکانیک یافت نشد" },
        { status: 403 }
      );
    }
    technicianId = technician.id;
  }

  const missions = await db.serviceBooking.findMany({
    where:
      session.role === "ADMIN"
        ? {}
        : {
            technicianId,
            status: {
              in: [
                "ASSIGNED",
                "EN_ROUTE",
                "ARRIVED",
                "INSPECTING",
                "WAITING_CUSTOMER_APPROVAL",
                "APPROVED",
                "IN_SERVICE",
                "FINAL_CHECK",
              ],
            },
          },
    include: {
      package: { include: { items: true } },
      timeline: { orderBy: { timestamp: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(missions);
}
