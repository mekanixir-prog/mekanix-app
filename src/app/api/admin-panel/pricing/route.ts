import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest, hasValidAdminCookieCsrf } from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/admin-api";
import {
  createDefaultRateCardIrr, isValidStoredRateCard, parseRateCardTomanInput,
  RATE_CARD_HISTORY_LIMIT, RATE_CARD_SETTING_KEY, type RateCardIrr,
} from "@/lib/money/rate-card";

type Snapshot = { version: number; updatedAt: string; updatedBy: string; rateCard: RateCardIrr };
type Envelope = { current: Snapshot; history: Snapshot[] };

function initialEnvelope(): Envelope {
  return {
    current: {
      version: 1, updatedAt: "2026-11-04T00:00:00.000Z",
      updatedBy: "owner-approved-baseline", rateCard: createDefaultRateCardIrr(),
    },
    history: [],
  };
}
function parseEnvelope(raw: string): Envelope | null {
  try {
    const value = JSON.parse(raw) as Envelope;
    if (!value?.current || !Number.isSafeInteger(value.current.version) || value.current.version < 1 ||
      !isValidStoredRateCard(value.current.rateCard) || !Array.isArray(value.history) ||
      value.history.length > RATE_CARD_HISTORY_LIMIT ||
      value.history.some((entry) => !entry || !Number.isSafeInteger(entry.version) ||
        entry.version < 1 || !isValidStoredRateCard(entry.rateCard))) return null;
    return value;
  } catch { return null; }
}

export async function GET(req: Request) {
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });
  const db = await getDbForLib();
  const setting = await db.platformSetting.findUnique({ where: { key: RATE_CARD_SETTING_KEY } });
  if (!setting) return NextResponse.json(initialEnvelope());
  const envelope = parseEnvelope(setting.value);
  if (!envelope) return NextResponse.json({ error: "نسخه ذخیره‌شده تعرفه معتبر نیست و نیازمند بررسی است" }, { status: 409 });
  return NextResponse.json(envelope);
}

export async function PATCH(req: Request) {
  if (!hasValidAdminCookieCsrf(req)) return NextResponse.json({ error: "درخواست از مبدأ نامعتبر است" }, { status: 403 });
  const session = await getAdminFromRequest(req);
  if (!session) return NextResponse.json({ error: "احراز هویت مدیر الزامی است" }, { status: 401 });
  if (session.role !== "SUPER_ADMIN") return NextResponse.json({ error: "فقط مدیر ارشد می‌تواند تعرفه مالی را تغییر دهد" }, { status: 403 });

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "بدنه درخواست نامعتبر است" }, { status: 400 });
  const input = body as Record<string, unknown>;
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) {
    return NextResponse.json({ error: "نسخه مورد انتظار نامعتبر است" }, { status: 400 });
  }

  let rateCard: RateCardIrr;
  try { rateCard = parseRateCardTomanInput(input.ratesToman); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "تعرفه نامعتبر است" }, { status: 400 });
  }

  const db = await getDbForLib();
  const existing = await db.platformSetting.findUnique({ where: { key: RATE_CARD_SETTING_KEY } });
  const current = existing ? parseEnvelope(existing.value) : initialEnvelope();
  if (!current) return NextResponse.json({ error: "نسخه فعلی تعرفه قابل خواندن نیست؛ تغییرات متوقف شد" }, { status: 409 });
  if (current.current.version !== input.expectedVersion) {
    return NextResponse.json({ error: "تعرفه توسط کاربر دیگری تغییر کرده است؛ صفحه را تازه‌سازی کنید", code: "RATE_CARD_VERSION_CONFLICT", currentVersion: current.current.version }, { status: 409 });
  }

  const next: Envelope = {
    current: { version: current.current.version + 1, updatedAt: new Date().toISOString(), updatedBy: session.adminId, rateCard },
    history: [current.current, ...current.history].slice(0, RATE_CARD_HISTORY_LIMIT),
  };
  const serialized = JSON.stringify(next);
  try {
    if (!existing) {
      await db.platformSetting.create({
        data: { key: RATE_CARD_SETTING_KEY, value: serialized, description: "Owner-approved MEKANIX fixed rate card; integer IRR storage", updatedBy: session.adminId },
      });
    } else {
      const result = await db.platformSetting.updateMany({
        where: { key: RATE_CARD_SETTING_KEY, value: existing.value },
        data: { value: serialized, updatedBy: session.adminId },
      });
      if (result.count !== 1) return NextResponse.json({ error: "تعرفه هم‌زمان تغییر کرده است؛ صفحه را تازه‌سازی کنید", code: "RATE_CARD_VERSION_CONFLICT" }, { status: 409 });
    }
  } catch {
    return NextResponse.json({ error: "ذخیره تعرفه هم‌زمان ناموفق بود؛ نسخه فعلی را دوباره بارگذاری کنید", code: "RATE_CARD_WRITE_CONFLICT" }, { status: 409 });
  }

  await writeAuditLog({
    session, action: "UPDATE_FIXED_RATE_CARD", entity: "PlatformSetting",
    entityId: RATE_CARD_SETTING_KEY, before: current.current, after: next.current, req,
  });
  return NextResponse.json(next);
}
