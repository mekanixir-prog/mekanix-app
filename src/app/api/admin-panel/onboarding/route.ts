import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/admin-api";

export async function GET(req: Request) {
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const slides = await db.onboardingSlide.findMany({ orderBy: { order: "asc" } });
  return NextResponse.json(slides);
}

export async function POST(req: Request) {
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const { image, imageBase64, titleFa, subtitleFa, tagFa, bulletsFa, titleEn, subtitleEn, tagEn, bulletsEn, accent, order } = body;

  if (!titleFa || !subtitleFa) return NextResponse.json({ error: "titleFa and subtitleFa required" }, { status: 400 });

  // Cloudflare Workers has no filesystem; image uploads are stored as data URLs
  // directly in the D1 `OnboardingSlide.image` column. The data: URL is
  // returned to clients verbatim and rendered inline.
  //
  // (Previously this wrote the decoded bytes to public/onboarding/<file>
  // via fs.writeFileSync — that path is no longer available on Workers.)
  let imagePath = image || "";
  if (imageBase64?.startsWith("data:")) {
    imagePath = imageBase64;
  }

  const lastSlide = await db.onboardingSlide.findFirst({ orderBy: { order: "desc" }, select: { order: true } });
  const newOrder = order ?? (lastSlide?.order ?? 0) + 1;

  const slide = await db.onboardingSlide.create({
    data: {
      order: newOrder, image: imagePath,
      titleFa, subtitleFa, tagFa: tagFa || "", bulletsFa: bulletsFa || "[]",
      titleEn: titleEn || titleFa, subtitleEn: subtitleEn || subtitleFa, tagEn: tagEn || tagFa || "", bulletsEn: bulletsEn || "[]",
      accent: accent || "amber",
    },
  });

  await writeAuditLog({ session, action: "CREATE_ONBOARDING_SLIDE", entity: "OnboardingSlide", entityId: slide.id, after: slide, req });
  return NextResponse.json(slide);
}
