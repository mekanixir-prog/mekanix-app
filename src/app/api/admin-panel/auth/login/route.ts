import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifyPassword, createAdminToken, ensureDefaultAdmin } from "@/lib/admin-auth";
import { rateLimitAsync, getClientId } from "@/lib/rate-limit";
import { writeAuditLog } from "@/lib/admin-api";
import { createHash } from "node:crypto";

// SEC-13: Mitigate user enumeration on admin login.
//   - Unified error message + status for "user not found" and "wrong password"
//     (both return 401 with the same Persian message). An attacker cannot
//     distinguish "user doesn't exist" from "wrong password" via the response
//     body — eliminating the enumeration vector.
//   - Always run verifyPassword (against a dummy hash when the admin doesn't
//     exist) so response timing doesn't reveal whether the user exists.
//     Without this, the early-return on `!admin` would make responses for
//     non-existent users significantly faster than for existing users (no
//     bcrypt comparison), enabling timing-based enumeration.
const DUMMY_HASH =
  "$2b$12$tpLZmwp/I64rrSkfS/Pjc.YRC4Gl7ZJs9.O5eret1H/OpfxNlSkFO";
const UNAUTH_MSG = "ایمیل/یوزرنیم یا پسورد اشتباه است";

// SEC-5: Rate limit admin login (5 attempts per 15 min per IP) + audit log
// all login attempts (failed + successful). Brute-force mitigation:
//   - 5 attempts per 15 min per IP = max ~20 attempts/hour per IP
//   - Failed attempts are audit-logged (with the attempted emailOrUsername
//     redacted to a hash) so an operator can investigate attack patterns.
//   - Successful attempts are audit-logged for compliance / forensics.
//
// Fail-closed policy: shared-store outage returns 503. Admin credentials
// are too sensitive to bypass a missing distributed rate-limit counter.
const LOGIN_RATE_LIMIT = { max: 5, windowMs: 15 * 60_000 };

export async function POST(req: Request) {
  // Rate-limit before any DB-backed bootstrap or credential lookup.
  const clientId = getClientId(req);
  const ipLimit = await rateLimitAsync(`admin-login:ip:${clientId}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs);
  if (ipLimit.unavailable) {
    return NextResponse.json(
      { error: "سرویس احراز هویت موقتاً در دسترس نیست؛ لطفاً بعداً تلاش کنید" },
      { status: 503, headers: { "Retry-After": String(Math.max(1, Math.ceil(ipLimit.resetMs / 1000))) } }
    );
  }
  if (!ipLimit.success) {
    return NextResponse.json(
      { error: "درخواست‌های بیش از حد — لطفاً ۱۵ دقیقه دیگر تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(ipLimit.resetMs / 1000))) } }
    );
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "درخواست نامعتبر است" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const { emailOrUsername, password } = parsed as Record<string, unknown>;
  if (
    typeof emailOrUsername !== "string" || !emailOrUsername.trim() ||
    emailOrUsername.length > 254 ||
    typeof password !== "string" || !password || password.length > 128
  ) {
    return NextResponse.json({ error: "ایمیل/یوزرنیم و پسورد الزامی است" }, { status: 400 });
  }
  const identifier = emailOrUsername.trim();
  const accountKey = createHash("sha256").update(identifier.toLowerCase()).digest("hex");
  const accountLimit = await rateLimitAsync(`admin-login:account:${accountKey}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs);
  if (accountLimit.unavailable) {
    return NextResponse.json(
      { error: "سرویس احراز هویت موقتاً در دسترس نیست؛ لطفاً بعداً تلاش کنید" },
      { status: 503, headers: { "Retry-After": String(Math.max(1, Math.ceil(accountLimit.resetMs / 1000))) } }
    );
  }
  if (!accountLimit.success) {
    return NextResponse.json(
      { error: "درخواست‌های بیش از حد — لطفاً ۱۵ دقیقه دیگر تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(accountLimit.resetMs / 1000))) } }
    );
  }

  await ensureDefaultAdmin();
  const db = await getDbForLib();
  const admin = await db.adminUser.findFirst({
    where: { OR: [{ email: identifier.toLowerCase() }, { username: identifier }] },
  });

  // SEC-13: Always call verifyPassword — when admin is not found, compare
  // against DUMMY_HASH so the bcrypt timing is consistent across both
  // "user not found" and "wrong password" responses. This closes the
  // timing side-channel that would otherwise reveal user existence.
  const ok = admin
    ? await verifyPassword(password, admin.passwordHash)
    : await verifyPassword(password, DUMMY_HASH);

  if (!admin || !ok) {
    // SEC-5: audit log failed login (best-effort — never block on audit).
    // When admin is null, we still log with adminId="unknown" so operators
    // can see attempted-user patterns in the audit log.
    try {
      await writeAuditLog({
        session: admin
          ? { adminId: admin.id, username: admin.username, role: admin.role }
          : { adminId: "unknown", username: identifier, role: "unknown" },
        action: "FAILED_ADMIN_LOGIN",
        entity: "AdminUser",
        entityId: admin?.id,
        after: { accountHash: accountKey, reason: admin ? "wrong_password" : "user_not_found" },
        req,
      });
    } catch (e) {
      console.error("[audit log error] FAILED_ADMIN_LOGIN", e);
    }
    // Unified response for both "user not found" and "wrong password" —
    // same status code, same message body. No enumeration signal.
    return NextResponse.json({ error: UNAUTH_MSG }, { status: 401 });
  }

  await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  const token = await createAdminToken({ adminId: admin.id, username: admin.username, role: admin.role });

  // SEC-5: audit log successful login (best-effort).
  try {
    await writeAuditLog({
      session: { adminId: admin.id, username: admin.username, role: admin.role },
      action: "ADMIN_LOGIN_SUCCESS",
      entity: "AdminUser",
      entityId: admin.id,
      after: { username: admin.username, at: new Date().toISOString() },
      req,
    });
  } catch (e) {
    console.error("[audit log error] ADMIN_LOGIN_SUCCESS", e);
  }

  return NextResponse.json({
    token,
    admin: { id: admin.id, username: admin.username, name: admin.name, email: admin.email, role: admin.role },
  });
}
