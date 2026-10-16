import { getDbForLib } from "./db-access";
import type { AdminSession } from "./admin-auth";

export function getPagination(req: Request) {
  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = parseInt(url.searchParams.get("limit") || "20");
  return { page: Math.max(1, page), limit: Math.min(100, Math.max(1, limit)) };
}

export function getQuery(req: Request) {
  return new URL(req.url).searchParams;
}

export async function writeAuditLog(opts: {
  session: AdminSession;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  req?: Request;
}) {
  try {
    const db = await getDbForLib();
    await db.auditLog.create({
      data: {
        adminId: opts.session.adminId,
        action: opts.action,
        entity: opts.entity,
        entityId: opts.entityId,
        before: opts.before ? JSON.stringify(opts.before) : null,
        after: opts.after ? JSON.stringify(opts.after) : null,
        ipAddress: opts.req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        userAgent: opts.req?.headers.get("user-agent") || null,
      },
    });
  } catch (e) {
    console.error("[audit log error]", e);
  }
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
