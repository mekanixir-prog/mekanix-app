import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

// GET /api/care/packages — list available service packages
export async function GET(req: Request) {
  const db = await getDbForLib();
  const url = new URL(req.url);
  const vehicleId = url.searchParams.get("vehicleId");

  const packages = await db.servicePackage.findMany({
    where: { active: true },
    include: { items: true },
    orderBy: { order: "asc" },
  });

  return NextResponse.json(packages);
}
