// MEKANIX — API Helpers for auth + rate limiting + validation
import { NextResponse } from "next/server";
import { getSessionFromRequest, type Session } from "./auth";
import { rateLimit, rateLimitAsync, getClientId } from "./rate-limit";

// Helper: extract + verify session from request. Returns 401 if not authenticated.
//
// Applies the default API rate limit (60 req/min per client) via the shared
// D1/SQLite/PostgreSQL-backed atomic counter. A production store outage must
// return 503 before session lookup; it must never fall back to isolate memory.
export async function requireAuth(req: Request): Promise<Session | NextResponse> {
  const clientId = getClientId(req);
  const rl = await rateLimitAsync(`api:${clientId}`, 60, 60_000); // 60 req/min
  if (rl.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": String(Math.max(1, Math.ceil(rl.resetMs / 1000))) } }
    );
  }
  if (!rl.success) {
    return NextResponse.json(
      { error: "درخواست‌های بیش از حد — لطفاً کمی صبر کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "احراز هویت نشده — لطفاً وارد شوید" }, { status: 401 });
  }
  return session;
}

// Helper: rate limit by phone (for OTP endpoints). Returns 429 if exceeded.
//
// DEPRECATED: This synchronous helper wraps the process-local in-memory
// `rateLimit()` and is not a production security boundary. No internal API
// route calls it; new code must use `rateLimitAsync()` and handle unavailable.
export function checkRateLimit(req: Request, key: string, max: number, windowMs: number): NextResponse | null {
  const clientId = getClientId(req);
  const rl = rateLimit(`${key}:${clientId}`, max, windowMs);
  if (!rl.success) {
    return NextResponse.json(
      { error: "درخواست‌های بیش از حد، بعداً دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }
  return null;
}

export async function validateBody<T>(req: Request, schema: import("zod").ZodSchema<T>): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  try {
    const body = await req.json();
    const result = schema.safeParse(body);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, response: NextResponse.json({ error: result.error.issues[0]?.message ?? "Invalid input" }, { status: 400 }) };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
}

// Re-export from auth for convenience
export { getSessionFromRequest, type Session } from "./auth";
