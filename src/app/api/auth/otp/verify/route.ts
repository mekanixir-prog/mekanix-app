import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { createSession } from "@/lib/auth";
import { validateBody } from "@/lib/api-helpers";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { otpVerifySchema } from "@/lib/schemas";
import { hashOtpCode } from "@/lib/otp-crypto";

const TECHNICIAN_INCLUDE = {
  specialties: true,
  certifications: true,
  serviceAreas: true,
} as const;

export async function POST(req: Request) {
  // Rate limit by client IP (5 verify attempts per minute) — uses the
  // Redis-backed `rateLimitAsync()` so the budget is shared across instances
  // when REDIS_URL is set. Falls back to in-memory in dev mode.
  const clientId = getClientId(req);
  const limited = await rateLimitAsync(
    `otp-verify:${clientId}`,
    RATE_LIMITS.OTP_VERIFY.max,
    RATE_LIMITS.OTP_VERIFY.windowMs
  );
  if (!limited.success) {
    return NextResponse.json(
      { error: "تعداد تلاش‌ها بیش از حد است، بعداً تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limited.resetMs / 1000)) } }
    );
  }

  // Validate request body with Zod — phone + 6-digit code are required.
  // `name` is optional and only used on first-time signup. The schema enforces
  // length and character-class so a malformed payload fails fast with a 400
  // (Persian error) instead of falling through to the DB lookup below.
  const body = await validateBody(req, otpVerifySchema);
  if (!body.ok) return body.response;

  // Normalize phone: strip spaces, dashes, parentheses.
  const phone = body.data.phone.replace(/[\s\-()]/g, "");
  const code = body.data.code;
  const name = body.data.name;

  // Hash the user-supplied code with the same SHA-256 used at send time so we
  // can match against the stored digest. The DB only ever holds the hash —
  // see `src/lib/otp-crypto.ts`. Note: this also means any OTP rows created
  // before this change (which stored plaintext codes) will simply fail to
  // match — the user will get a 400 and can request a new code. That's the
  // correct, secure behavior; we do NOT fall back to plaintext lookup.
  const codeHash = hashOtpCode(code);

  const db = await getDbForLib();

  // SEC-10 fix: atomic one-time-code consumption.
  // Previously: findFirst({ consumed: false }) + update({ consumed: true })
  // were two separate non-atomic queries. Two concurrent verify requests
  // with the same valid code could both pass findFirst and both call update,
  // violating the one-time-code contract.
  //
  // Now: a single conditional updateMany atomically transitions the code
  // from consumed:false → consumed:true ONLY if it is still unconsumed AND
  // not expired. count === 1 means we won the race; count === 0 means the
  // code was already used/expired/invalid — same 400 error as before.
  // Note: WHERE clause uses `code: codeHash` because the DB stores the hash,
  // not the plaintext code.
  const now = new Date();
  const consumed = await db.otpCode.updateMany({
    where: {
      phone,
      code: codeHash,
      consumed: false,
      expiresAt: { gt: now },
    },
    data: { consumed: true },
  });

  if (consumed.count === 0) {
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
  }

  // Try to find user by normalized phone first, then by phone digits only.
  // This handles legacy users whose phones were stored with dashes/spaces
  // (e.g. "+1-415-224-1180" should match "+14152241180").
  //
  // D1-02 FIX: previously used db.user.findMany({ select: { id, phone } })
  // — an unbounded full-table scan on every OTP verify. Now uses a bounded
  // query: try several common phone format variants as findUnique lookups
  // (each is an indexed O(1) lookup on the @unique phone column).
  const phoneDigits = phone.replace(/\D/g, "");
  let user = await db.user.findUnique({
    where: { phone },
    include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
  });

  if (!user && phoneDigits) {
    // D1-02 fix: try common phone format variants as indexed findUnique
    // lookups instead of scanning all users. Each variant is an O(1) lookup
    // on the @unique phone column.
    //
    // We generate variants that cover the most common formats:
    //   Iranian (+98 912 345 6789):
    //     +989123456789, 989123456789, 09123456789, +98 912 345 6789, +98-912-345-6789
    //   International (+1-415-224-1180):
    //     14152241180, +14152241180, +1-415-224-1180, +1 415 224 1180
    //
    // The key insight: we try the raw digits, +digits, and several
    // formatted variants that cover 1-digit CC (US, etc.) and 2-digit CC
    // (Iran, EU, etc.).

    const phoneVariants = new Set<string>();

    // Raw digits (no +)
    phoneVariants.add(phoneDigits);

    // +digits
    phoneVariants.add(`+${phoneDigits}`);

    // For Iranian numbers (start with 98 after removing +), try common formats:
    if (phoneDigits.startsWith("98") && phoneDigits.length >= 12) {
      // +98 912 345 6789
      phoneVariants.add(`+98 ${phoneDigits.slice(2, 5)} ${phoneDigits.slice(5, 8)} ${phoneDigits.slice(8)}`);
      // +98-912-345-6789
      phoneVariants.add(`+98-${phoneDigits.slice(2, 5)}-${phoneDigits.slice(5, 8)}-${phoneDigits.slice(8)}`);
      // 09123456789 (Iranian local format — strip 98, add 0)
      phoneVariants.add(`0${phoneDigits.slice(2)}`);
    }

    // For 1-digit CC numbers (US: +1-415-224-1180):
    if (phoneDigits.length >= 10 && !phoneDigits.startsWith("98")) {
      const cc = phoneDigits.slice(0, 1);
      const rest = phoneDigits.slice(1);
      if (rest.length >= 9) {
        phoneVariants.add(`+${cc}-${rest.slice(0, 3)}-${rest.slice(3, 6)}-${rest.slice(6)}`);
        phoneVariants.add(`+${cc} ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`);
      }
    }

    // Remove the original phone and empty strings
    phoneVariants.delete(phone);
    phoneVariants.delete("");

    for (const variant of phoneVariants) {
      user = await db.user.findUnique({
        where: { phone: variant },
        include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
      });
      if (user) {
        // Normalize the stored phone so future lookups match directly
        if (user.phone !== phone) {
          user = await db.user.update({
            where: { id: user.id },
            data: { phone },
            include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
          });
        }
        break;
      }
    }
  }
  let created = false;
  if (!user) {
    const derivedName = name?.trim() || `MEKANIX User ${phone.slice(-4)}`;
    user = await db.user.create({
      data: {
        phone, phoneVerified: true,
        email: `+${phone.replace(/\D/g, "")}@mekanix.guest`,
        name: derivedName, role: "CUSTOMER",
      },
      include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
    created = true;
    await db.customer.create({ data: { userId: user.id } });
    // Re-fetch with includes — but keep the created user as fallback
    // in case the re-fetch returns null (e.g. in tests or edge cases).
    const refetched = await db.user.findUnique({
      where: { id: user.id },
      include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
    if (refetched) user = refetched;
  } else if (!user.phoneVerified) {
    user = await db.user.update({
      where: { id: user.id }, data: { phoneVerified: true },
      include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
  }

  if (!user!.customer) {
    try {
      await db.customer.create({ data: { userId: user!.id } });
    } catch {}
    user = await db.user.findUnique({
      where: { id: user!.id },
      include: { customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
  }

  const token = await createSession(
    {
      userId: user!.id, role: user!.role, phone: user!.phone, isGuest: false,
    },
    req, // Pass request for device/IP tracking in the Session DB record
  );

  // Set HttpOnly cookie — JavaScript cannot access it (XSS protection).
  // The session JWT is NEVER exposed to client-side JS: it lives only in the
  // HttpOnly cookie, which `fetch(..., { credentials: "include" })` sends
  // automatically on every same-origin API call.
  const response = NextResponse.json({ user, created });
  response.cookies.set("mekanix-token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    path: "/",
  });
  // NOTE: We intentionally do NOT return the JWT in the body or any header.
  // For WebSocket auth, frontend should call /api/auth/ws-token to get a
  // short-lived (5min) token. The main session JWT stays in HttpOnly cookie
  // and is never exposed to JS.
  // TODO(security): Implement /api/auth/ws-token endpoint that:
  //   1. Reads the HttpOnly session cookie via requireAuth(req).
  //   2. Mints a separate short-lived WS token (5min TTL, scoped to userId+role).
  //   3. Returns it in the JSON body (safe — it expires fast and is WS-only).
  // The WS gateway then verifies the WS token on connection.
  return response;
}
