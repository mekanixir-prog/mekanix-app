import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest, hasValidAdminCookieCsrf } from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/admin-api";
import { DEFAULT_PRICING_RATE_CARD, PRICING_RATE_CARD_KEY, validatePricingRateCard, type PricingRateCard } from "@/lib/pricing-rate-card";

type Stored = { current: PricingRateCard; history: PricingRateCard[] };
async function read(db: Awaited<ReturnType<typeof getDbForLib>>): Promise<Stored> {
  const row = await db.platformSetting.findUnique({ where: { key: PRICING_RATE_CARD_KEY } });
  if (!row) return { current: DEFAULT_PRICING_RATE_CARD, history: [] };
  const value = JSON.parse(row.value) as Partial<Stored>;
  if (!value.current || !Array.isArray(value.history)) throw new Error("ساختار نرخ‌نامه نامعتبر است");
  return { current: value.current, history: value.history.slice(0, 20) };
}
export async function GET(req: Request) {
  if (!await getAdminFromRequest(req)) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });
  try { return NextResponse.json(await read(await getDbForLib()), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "خواندن نرخ‌نامه ناموفق بود" }, { status: 500 }); }
}
export async function PUT(req: Request) {
  if (!hasValidAdminCookieCsrf(req)) return NextResponse.json({ error: "درخواست از مبدأ نامعتبر است" }, { status: 403 });
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("rateCard" in body)) return NextResponse.json({ error: "نرخ‌نامه ارسال نشده است" }, { status: 400 });
  try {
    const db = await getDbForLib();
    const before = await read(db);
    const clean = validatePricingRateCard((body as { rateCard: unknown }).rateCard);
    const now = new Date().toISOString();
    const current: PricingRateCard = {
      ...clean, schemaVersion: 1, version: before.current.version + 1, currency: "IRR", displayCurrency: "TOMAN",
      effectiveAt: now, updatedAt: now, updatedBy: session.username || session.adminId,
    };
    const next: Stored = { current, history: [before.current, ...before.history].slice(0, 20) };
    const existingRow = await db.platformSetting.findUnique({ where: { key: PRICING_RATE_CARD_KEY } });
    if (existingRow) {
      const changed = await db.platformSetting.updateMany({
        where: { key: PRICING_RATE_CARD_KEY, value: existingRow.value },
        data: { value: JSON.stringify(next), description: "MEKANIX editable versioned IRR rate card", updatedBy: session.adminId },
      });
      if (changed.count !== 1) return NextResponse.json({ error: "نرخ‌نامه هم‌زمان توسط مدیر دیگری تغییر کرده است؛ صفحه را تازه‌سازی کنید" }, { status: 409 });
    } else {
      try {
        await db.platformSetting.create({
          data: { key: PRICING_RATE_CARD_KEY, value: JSON.stringify(next), description: "MEKANIX editable versioned IRR rate card", updatedBy: session.adminId },
        });
      } catch {
        return NextResponse.json({ error: "نرخ‌نامه هم‌زمان ایجاد شده است؛ صفحه را تازه‌سازی کنید" }, { status: 409 });
      }
    }
    await writeAuditLog({ session, action: "UPDATE_PRICING_RATE_CARD", entity: "PricingRateCard", entityId: String(current.version), before: before.current, after: current, req });
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ذخیره نرخ‌نامه ناموفق بود" }, { status: 400 });
  }
}
