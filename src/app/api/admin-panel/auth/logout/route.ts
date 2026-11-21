import { NextResponse } from "next/server";
import { getDbForLib } from "@/lib/db-access";
import {
  clearAdminSessionCookie,
  getAdminCookieToken,
  getAdminFromRequest,
  isSameOriginRequest,
} from "@/lib/admin-auth";
import { writeAuditLog } from "@/lib/admin-api";

export async function POST(req: Request) {
  const hasCookie = Boolean(getAdminCookieToken(req));
  if (hasCookie && !isSameOriginRequest(req)) {
    return NextResponse.json({ error: "درخواست از مبدأ نامعتبر است" }, { status: 403 });
  }

  const session = hasCookie ? await getAdminFromRequest(req) : null;
  if (session && Number.isSafeInteger(session.sessionVersion)) {
    const db = await getDbForLib();
    const result = await db.adminUser.updateMany({
      where: { id: session.adminId, sessionVersion: session.sessionVersion },
      data: { sessionVersion: { increment: 1 } },
    });

    if (result.count === 1) {
      await writeAuditLog({
        session,
        action: "ADMIN_LOGOUT",
        entity: "AdminUser",
        entityId: session.adminId,
        req,
      });
    }
  }

  const response = NextResponse.json({ ok: true });
  clearAdminSessionCookie(response, req);
  return response;
}
