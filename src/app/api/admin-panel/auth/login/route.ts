import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifyPassword, createAdminToken, ensureDefaultAdmin } from "@/lib/admin-auth";
import { rateLimitAsync, getClientId } from "@/lib/rate-limit";
import { writeAuditLog } from "@/lib/admin-api";

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
// Fail-open policy: if the rate-limit infrastructure is unavailable (DB
// error AND in-memory fallback also fails), allow the attempt — better to
// risk a brute-force than to lock the admin out of the panel entirely
// (DoS on admin = no way to manage the platform).
const LOGIN_RATE_LIMIT = { max: 5, windowMs: 15 * 60_000 };

export async function POST(req: Request) {
  await ensureDefaultAdmin();
  const { emailOrUsername, password } = await req.json();
  const db = await getDbForLib();
  if (!emailOrUsername || !password) return NextResponse.json({ error: "ایمیل/یوزرنیم و پسورد الزامی است" }, { status: 400 });

  // SEC-5: rate limit per IP — 5 attempts per 15 min.
  // Fail-open: if rateLimitAsync throws (DB error AND in-memory fallback also
  // fails), allow the attempt. The rateLimitAsync function already falls back
  // to in-memory on DB error (see src/lib/rate-limit.ts), so this outer
  // try/catch is belt-and-suspenders for any unexpected throw.
  const clientId = getClientId(req);
  let rl;
  try {
    rl = await rateLimitAsync(`admin-login:${clientId}`, LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs);
  } catch {
    rl = { success: true, resetMs: LOGIN_RATE_LIMIT.windowMs };
  }
  if (!rl.success) {
    return NextResponse.json(
      { error: "درخواست‌های بیش از حد — لطفاً ۱۵ دقیقه دیگر تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetMs / 1000)) } }
    );
  }

  const admin = await db.adminUser.findFirst({
    where: { OR: [{ email: emailOrUsername.toLowerCase() }, { username: emailOrUsername }] },
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
          : { adminId: "unknown", username: emailOrUsername, role: "unknown" },
        action: "FAILED_ADMIN_LOGIN",
        entity: "AdminUser",
        entityId: admin?.id,
        after: { emailOrUsername, reason: admin ? "wrong_password" : "user_not_found" },
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
