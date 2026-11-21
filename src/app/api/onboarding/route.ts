import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";

export async function GET() {
  try {
    const db = await getDbForLib();
    const slides = await db.onboardingSlide.findMany({
      where: { active: true },
      orderBy: { order: "asc" },
    });
    return NextResponse.json(slides);
  } catch {
    return NextResponse.json([]);
  }
}
