import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { createSession } from "@/lib/auth";
import { validateBody } from "@/lib/api-helpers";
import { rateLimitAsync, getClientId, RATE_LIMITS } from "@/lib/rate-limit";
import { otpVerifySchema } from "@/lib/schemas";
import { hashOtpCode, hashOtpPhone } from "@/lib/otp-crypto";
import { AUTH_USER_SELECT } from "@/lib/user-select";
import { maskTechnicianFinancialData } from "@/lib/money/financial-read-mask";
import { getPhoneLookupVariants, normalizePhoneForStorage } from "@/lib/phone-normalization";

const TECHNICIAN_INCLUDE = {
  specialties: true,
  certifications: true,
  serviceAreas: true,
} as const;

export async function POST(req: Request) {
  // Rate limit by client IP (5 verify attempts per minute) — uses the
  // D1-backed `rateLimitAsync()` so the budget is shared across Worker isolates.
  // Falls back to in-memory only in non-production development.
  const clientId = getClientId(req);
  const limited = await rateLimitAsync(
    `otp-verify:${clientId}`,
    RATE_LIMITS.OTP_VERIFY.max,
    RATE_LIMITS.OTP_VERIFY.windowMs
  );
  if (limited.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  }
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
  const phone = normalizePhoneForStorage(body.data.phone);
  const code = body.data.code;
  const name = body.data.name;

  // A per-phone budget complements the per-IP budget: attackers can spread
  // guesses across many IP addresses. HMAC the identifier before storing it.
  let phoneRateLimitKey: string;
  try {
    phoneRateLimitKey = hashOtpPhone(phone);
  } catch {
    return NextResponse.json(
      { error: "سرویس احراز هویت موقتاً آماده نیست" },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }

  const phoneLimited = await rateLimitAsync(
    `otp-verify:phone:${phoneRateLimitKey}`,
    5,
    10 * 60 * 1000
  );
  if (phoneLimited.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  }
  if (!phoneLimited.success) {
    return NextResponse.json(
      { error: "تعداد تلاش‌های کد تأیید برای این شماره بیش از حد است" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(phoneLimited.resetMs / 1000)) } }
    );
  }

  // Match the keyed HMAC produced at send time. Existing pending SHA-256
  // OTP rows are intentionally not accepted after deployment; users can
  // request a fresh code. Never fall back to an unkeyed legacy digest.
  let codeHash: string;
  try {
    codeHash = hashOtpCode(code);
  } catch {
    return NextResponse.json(
      { error: "سرویس احراز هویت موقتاً آماده نیست" },
      { status: 503, headers: { "Retry-After": "60" } }
    );
  }

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
  // Note: WHERE clause uses `code: codeHash` because the DB stores the keyed
  // verifier, not the plaintext code.
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

  // Always try the canonical identity first. Then inspect bounded legacy
  // variants so old formatted accounts can be linked without creating a
  // second identity. If variants resolve to different accounts, fail closed
  // rather than silently choosing or merging one.
  const phoneVariants = [
    phone,
    ...getPhoneLookupVariants(body.data.phone).filter((variant) => variant !== phone),
  ];
  let user = null;
  for (const variant of phoneVariants) {
    const match = await db.user.findUnique({
      where: { phone: variant },
      select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
    if (!match) continue;
    if (user && user.id !== match.id) {
      return NextResponse.json(
        { error: "چند حساب با قالب‌های مختلف این شماره وجود دارد؛ برای یکسان‌سازی حساب‌ها با پشتیبانی تماس بگیرید" },
        { status: 409 },
      );
    }
    user = match;
  }

  if (user && user.phone !== phone) {
    try {
      user = await db.user.update({
        where: { id: user.id },
        data: { phone },
        select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
      });
    } catch (error) {
      const value = error as { code?: string } | null;
      if (value?.code === "P2002") {
        return NextResponse.json(
          { error: "برای این شماره بیش از یک حساب ثبت شده است؛ برای یکسان‌سازی با پشتیبانی تماس بگیرید" },
          { status: 409 },
        );
      }
      throw error;
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
      select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
    created = true;
    await db.customer.create({ data: { userId: user.id } });
    // Re-fetch with includes — but keep the created user as fallback
    // in case the re-fetch returns null (e.g. in tests or edge cases).
    const refetched = await db.user.findUnique({
      where: { id: user.id },
      select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
    if (refetched) user = refetched;
  } else if (!user.phoneVerified) {
    user = await db.user.update({
      where: { id: user.id }, data: { phoneVerified: true },
      select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
    });
  }

  if (!user!.customer) {
    try {
      await db.customer.create({ data: { userId: user!.id } });
    } catch {}
    user = await db.user.findUnique({
      where: { id: user!.id },
      select: { ...AUTH_USER_SELECT, customer: true, technician: { include: TECHNICIAN_INCLUDE } },
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
  const safeUser = user?.technician
    ? { ...user, technician: maskTechnicianFinancialData(user.technician) }
    : user;
  const response = NextResponse.json({ user: safeUser, created });
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
