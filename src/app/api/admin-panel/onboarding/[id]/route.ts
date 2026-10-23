import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/admin-api";

// Allowed fields for PATCH (mass-assignment protection — S1 fix).
// Types are validated explicitly below; sanitizeInput alone only filters keys.
const VALID_ACCENTS = ["amber", "blue", "green", "red", "purple", "orange", "teal"] as const;

function sanitizeOnboardingUpdate(body: Record<string, any>): Record<string, any> {
  const safe: Record<string, any> = {};

  // String fields — validated + truncated
  if (typeof body.titleFa === "string") safe.titleFa = body.titleFa.slice(0, 200);
  if (typeof body.subtitleFa === "string") safe.subtitleFa = body.subtitleFa.slice(0, 300);
  if (typeof body.tagFa === "string") safe.tagFa = body.tagFa.slice(0, 50);
  if (typeof body.bulletsFa === "string") safe.bulletsFa = body.bulletsFa.slice(0, 2000);
  if (typeof body.titleEn === "string") safe.titleEn = body.titleEn.slice(0, 200);
  if (typeof body.subtitleEn === "string") safe.subtitleEn = body.subtitleEn.slice(0, 300);
  if (typeof body.tagEn === "string") safe.tagEn = body.tagEn.slice(0, 50);
  if (typeof body.bulletsEn === "string") safe.bulletsEn = body.bulletsEn.slice(0, 2000);
  if (typeof body.image === "string") safe.image = body.image.slice(0, 100000); // data URL can be large

  // Enum fields
  if (typeof body.accent === "string" && (VALID_ACCENTS as readonly string[]).includes(body.accent)) {
    safe.accent = body.accent;
  }

  // Numeric fields
  if (typeof body.order === "number" && Number.isFinite(body.order) && body.order >= 0) {
    safe.order = Math.floor(body.order);
  }

  return safe;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDbForLib();

  const before = await db.onboardingSlide.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const { imageBase64, ...rest } = body;

  // Cloudflare Workers has no filesystem; image uploads are stored as data URLs
  // directly in the D1 `OnboardingSlide.image` column.
  if (typeof imageBase64 === "string" && imageBase64.startsWith("data:")) {
    rest.image = imageBase64;
  }

  // S1 FIX: sanitize + validate — only whitelisted fields with correct types
  // are passed to update(). Previously, the entire request body (rest) was
  // passed directly, allowing mass-assignment of id, createdAt, etc.
  const safe = sanitizeOnboardingUpdate(rest);
  if (Object.keys(safe).length === 0) {
    return NextResponse.json({ error: "هیچ فیلد معتبری برای به‌روزرسانی ارسال نشده است" }, { status: 400 });
  }

  const updated = await db.onboardingSlide.update({ where: { id }, data: safe });
  await writeAuditLog({ session, action: "UPDATE_ONBOARDING_SLIDE", entity: "OnboardingSlide", entityId: id, before, after: updated, req });
  return NextResponse.json(updated);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDbForLib();

  const before = await db.onboardingSlide.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.onboardingSlide.delete({ where: { id } });
  await writeAuditLog({ session, action: "DELETE_ONBOARDING_SLIDE", entity: "OnboardingSlide", entityId: id, before, req });
  return NextResponse.json({ ok: true });
}
