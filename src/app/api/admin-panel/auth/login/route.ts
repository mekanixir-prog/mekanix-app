import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import { verifyPassword, createAdminToken, ensureDefaultAdmin } from "@/lib/admin-auth";

export async function POST(req: Request) {
  await ensureDefaultAdmin();
  const { emailOrUsername, password } = await req.json();
  const db = await getDbForLib();
  if (!emailOrUsername || !password) return NextResponse.json({ error: "ایمیل/یوزرنیم و پسورد الزامی است" }, { status: 400 });

  const admin = await db.adminUser.findFirst({
    where: { OR: [{ email: emailOrUsername.toLowerCase() }, { username: emailOrUsername }] },
  });
  if (!admin) return NextResponse.json({ error: "کاربر یافت نشد" }, { status: 404 });

  const ok = await verifyPassword(password, admin.passwordHash);
  if (!ok) return NextResponse.json({ error: "پسورد اشتباه است" }, { status: 401 });

  await db.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  const token = await createAdminToken({ adminId: admin.id, username: admin.username, role: admin.role });
  return NextResponse.json({ token, admin: { id: admin.id, username: admin.username, name: admin.name, email: admin.email, role: admin.role } });
}
