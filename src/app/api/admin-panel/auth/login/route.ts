import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifyPassword, createAdminToken, ensureDefaultAdmin } from "@/lib/admin-auth";

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

export async function POST(req: Request) {
  await ensureDefaultAdmin();
  const { emailOrUsername, password } = await req.json();
  const db = await getDbForLib();
  if (!emailOrUsername || !password) return NextResponse.json({ error: "ایمیل/یوزرنیم و پسورد الزامی است" }, { status: 400 });

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
    // Unified response for both "user not found" and "wrong password" —
    // same status code, same message body. No enumeration signal.
    return NextResponse.json({ error: UNAUTH_MSG }, { status: 401 });
  }

  await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  const token = await createAdminToken({ adminId: admin.id, username: admin.username, role: admin.role });
  return NextResponse.json({ token, admin: { id: admin.id, username: admin.username, name: admin.name, email: admin.email, role: admin.role } });
}
