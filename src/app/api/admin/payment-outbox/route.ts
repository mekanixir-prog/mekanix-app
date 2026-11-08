import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { getAdminFromRequest } from "@/lib/admin-auth";

const STATUSES = ["PENDING", "PROCESSING", "PROCESSED", "DEAD"] as const;
type OutboxStatus = (typeof STATUSES)[number];

function parsePositiveInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null || value === "") return fallback;
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return null;
  return parsed;
}

function sanitizeLastError(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300);
}

/**
 * Read-only operator view for durable payment outbox events.
 * Payloads and customer data are deliberately never selected or returned.
 * Replay and state transitions remain unavailable through this endpoint.
 */
export async function GET(req: Request) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return NextResponse.json(
      { error: "احراز هویت مدیر الزامی است" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  if (rawStatus && !STATUSES.includes(rawStatus as OutboxStatus)) {
    return NextResponse.json(
      { error: "وضعیت رویداد نامعتبر است", code: "INVALID_OUTBOX_STATUS" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const page = parsePositiveInteger(url.searchParams.get("page"), 1, 10000);
  const limit = parsePositiveInteger(url.searchParams.get("limit"), 20, 100);
  if (page === null || limit === null) {
    return NextResponse.json(
      { error: "پارامترهای صفحه‌بندی نامعتبر هستند", code: "INVALID_PAGINATION" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const db = await getDbForLib();
    const where = rawStatus ? { status: rawStatus as OutboxStatus } : {};
    const [events, total, pending, processing, processed, dead] = await Promise.all([
      db.paymentOutboxEvent.findMany({
        where,
        select: {
          id: true,
          eventType: true,
          aggregateType: true,
          aggregateId: true,
          idempotencyKey: true,
          status: true,
          attempts: true,
          availableAt: true,
          lockedAt: true,
          processedAt: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.paymentOutboxEvent.count({ where }),
      db.paymentOutboxEvent.count({ where: { status: "PENDING" } }),
      db.paymentOutboxEvent.count({ where: { status: "PROCESSING" } }),
      db.paymentOutboxEvent.count({ where: { status: "PROCESSED" } }),
      db.paymentOutboxEvent.count({ where: { status: "DEAD" } }),
    ]);

    return NextResponse.json(
      {
        summary: { pending, processing, processed, dead },
        events: events.map((event) => ({
          ...event,
          lastError: sanitizeLastError(event.lastError),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        readOnly: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[admin/payment-outbox] read failed", error);
    return NextResponse.json(
      { error: "نمایش صف پرداخت موقتاً در دسترس نیست", code: "PAYMENT_OUTBOX_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
