import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { validateBody } from "@/lib/api-helpers";
import { rateLimitAsync, getClientId } from "@/lib/rate-limit";
import { otpSendSchema } from "@/lib/schemas";
import { generateOtpCode, hashOtpCode } from "@/lib/otp-crypto";
import { sendOtp } from "@/lib/sms-provider";

// Send an OTP code to a phone number.
// - Rate-limited per-phone (5 / 10min) AND per-IP (20 / hour).
// - The code is generated with a CSPRNG (`crypto.randomInt`) — NOT Math.random.
// - The code is HASHED (SHA-256) before storage, so a read-only DB leak
//   (SQL injection, backup theft, snapshot access) cannot reveal usable
//   codes. See `src/lib/otp-crypto.ts` for the threat model.
// - In development, the plaintext code is returned so the UI can display it
//   for testing. In production, the plaintext is NEVER returned in the
//   response body — it must be delivered out-of-band (SMS / push) so a
//   malicious response interceptor or XSS cannot read it.
export async function POST(req: Request) {
  // Validate request body with Zod before touching any rate-limit / DB state.
  // The schema enforces phone length + character-class, so a junk payload
  // fails fast with a 400 (and Persian error) instead of consuming rate-limit
  // budget or hitting Prisma with malformed input.
  const body = await validateBody(req, otpSendSchema);
  if (!body.ok) return body.response;

  // Normalize phone: strip spaces, dashes, parentheses before storing/lookup.
  // The schema already proved the input is well-formed, so this only sanitizes
  // formatting — it can no longer reject a previously-accepted payload.
  const phone = body.data.phone.replace(/[\s\-()]/g, "");

  if (!phone || phone.length < 8) {
    // Defensive: schema should already prevent this, but keep the guard in case
    // the normalization above unexpectedly strips too much (e.g. an all-dashes input).
    return NextResponse.json({ error: "شماره موبایل معتبر وارد کنید" }, { status: 400 });
  }

  // Rate limit by phone (5 per 10 min) — protects a single user from OTP spam.
  // Uses Redis-backed rateLimitAsync when REDIS_URL is set (distributed across
  // instances); falls back to in-memory in dev mode. See `src/lib/rate-limit.ts`.
  const phoneLimited = await rateLimitAsync(`otp-send:phone:${phone}`, 5, 10 * 60 * 1000);
  if (phoneLimited.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  }
  if (!phoneLimited.success) {
    return NextResponse.json(
      { error: "تعداد درخواست‌های کد تأیید برای این شماره بیش از حد است" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(phoneLimited.resetMs / 1000)) } }
    );
  }

  // Rate limit by client IP (20 per hour) — protects against enumeration / abuse
  // across many phone numbers from a single attacker.
  const clientId = getClientId(req);
  const ipLimited = await rateLimitAsync(`otp-send:ip:${clientId}`, 20, 60 * 60 * 1000);
  if (ipLimited.unavailable) {
    return NextResponse.json(
      { error: "سرویس محدودسازی درخواست موقتاً در دسترس نیست" },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  }
  if (!ipLimited.success) {
    return NextResponse.json(
      { error: "تعداد درخواست‌ها از این آدرس بیش از حد است" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(ipLimited.resetMs / 1000)) } }
    );
  }

  // 6-digit numeric code, valid for 5 minutes.
  //
  // SECURITY: `generateOtpCode()` uses Node's CSPRNG (`crypto.randomInt`),
  // NOT `Math.random()`. An attacker who can predict `Math.random()` outputs
  // (e.g. by observing enough outputs to reconstruct the V8 PRNG state) could
  // mint valid OTP codes for any phone. CSPRNG output is unpredictable.
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  // Hash the code before persisting — see `src/lib/otp-crypto.ts`. The
  // plaintext `code` variable above is NEVER written to the DB; only its
  // SHA-256 hex digest is stored. The verify route re-hashes the
  // user-supplied code and matches the digest.
  const codeHash = hashOtpCode(code);

  // Invalidate any previous unconsumed codes for this phone (only the newest one is valid).
  const db = await getDbForLib();
  await db.otpCode.updateMany({ where: { phone, consumed: false }, data: { consumed: true } });
  await db.otpCode.create({ data: { phone, code: codeHash, expiresAt } });

  // Deliver the OTP via the configured SMS provider.
  //
  // `sendOtp()` is env-driven (see `src/lib/sms-provider.ts`):
  //   - SMS_PROVIDER=kavenegar    + KAVENEGAR_API_KEY    → Kavenegar verify/lookup
  //   - SMS_PROVIDER=melipayamak  + MELIPAYAMAK_USERNAME  → MeliPayamak SendSMS
  //   - SMS_PROVIDER=farapayamak  + FARAPAYAMAK_USERNAME  → Farapayamak SimpleSMS
  //   - default                                          → console.log (dev mode)
  //
  // In production the plaintext `code` is sent to the user's phone; in dev
  // mode it is logged to stdout AND returned in the response body so the
  // splash UI can display it for manual testing.
  //
  // Send failure is logged but does NOT abort the request — the hashed code
  // is already persisted, so the user can still verify via a retry / fallback
  // channel. We surface the error in the response body in dev so a misconfigured
  // SMS provider is visible during integration testing.
  const smsResult = await sendOtp(phone, code);
  if (!smsResult.success) {
    console.warn(`⚠️  SMS delivery failed for ${phone}: ${smsResult.error}`);
  }

  const isProduction = process.env.NODE_ENV === "production";
  const response: {
    ok: true;
    expiresAt: Date;
    code?: string;
    sms?: { success: boolean; error?: string };
  } = { ok: true, expiresAt };
  if (!isProduction) {
    // Dev only — the splash UI displays this so a human tester can read the code.
    response.code = code;
    // Surface SMS delivery status in dev so a misconfigured provider is visible.
    response.sms = {
      success: smsResult.success,
      error: smsResult.error,
    };
  }
  return NextResponse.json(response);
}
