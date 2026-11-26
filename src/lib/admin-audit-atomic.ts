import type { PrismaClient } from "@prisma/client";
import { getD1Binding } from "@/lib/idempotency";

type AuditActor = { id: string; role: string };
type AuditContext = { actor: AuditActor; req: Request; action: string; entity: string; entityId: string; snapshot: unknown };

type D1Statement = { bind: (...values: unknown[]) => D1Statement };
type D1Database = { prepare(sql: string): D1Statement; batch(statements: D1Statement[]): Promise<unknown[]> };

const sensitiveKey = /(password|passwd|otp|secret|token|authorization|cookie|payment.?payload|gateway.?payload|card.?number|cvv|cvc|iban|account.?number|balance|amount|base.?price|price|rate|fee|financial)/i;

export function redactAuditSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 50).map(redactAuditSnapshot);
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.slice(0, 500);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key)) continue;
    const redacted = redactAuditSnapshot(nested);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

function auditEnvelope(context: AuditContext, outcome: "SUCCESS" | "IN_PROGRESS") {
  const requestId = context.req.headers.get("x-request-id")?.trim().slice(0, 128) || crypto.randomUUID();
  return JSON.stringify({
    actor: { id: context.actor.id, role: context.actor.role },
    requestId,
    outcome,
    snapshot: redactAuditSnapshot(context.snapshot),
  });
}

function auditValues(context: AuditContext, id: string, createdAt: string, outcome: "SUCCESS" | "IN_PROGRESS") {
  return [
    id,
    context.actor.id,
    context.action,
    context.entity,
    context.entityId,
    null,
    auditEnvelope(context, outcome),
    context.req.headers.get("cf-connecting-ip") || null,
    context.req.headers.get("user-agent") || null,
    createdAt,
  ] as const;
}

function isWorker() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

function d1AuditInsert(d1: D1Database, values: readonly unknown[]) {
  return d1.prepare(
    'INSERT OR IGNORE INTO "AuditLog" ("id","adminId","action","entity","entityId","before","after","ipAddress","userAgent","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(...values);
}

const d1AssertOneChange = (d1: D1Database) =>
  d1.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('not-json', '$') END").bind();

type CarePackageInput = {
  name: string; nameFa: string; description: string | null; category: string; basePrice: number; order: number;
};

type MaintenanceRuleInput = {
  brand: string; model: string | null; yearFrom: number | null; yearTo: number | null;
  engine: string | null; mileageInterval: number | null; timeInterval: number | null;
  category: string; priority: string; version: string;
};

export async function createCarePackageWithAudit(
  db: PrismaClient, input: CarePackageInput, actor: AuditActor, req: Request
) {
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const snapshot = { id, name: input.name, nameFa: input.nameFa, category: input.category, active: true, version: "1.0", order: input.order };
  const context: AuditContext = { actor, req, action: "CREATE_CARE_SERVICE_PACKAGE", entity: "ServicePackage", entityId: id, snapshot };
  const auditId = `audit_care_package_${id}`;
  if (isWorker()) {
    const d1 = await getD1Binding() as unknown as D1Database;
    await d1.batch([
      d1.prepare('INSERT INTO "ServicePackage" ("id","financialUnitStatus","name","nameFa","description","category","basePrice","active","version","order","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, "UNVERIFIED", input.name, input.nameFa, input.description, input.category, input.basePrice, true, "1.0", input.order, createdAt, createdAt),
      d1AuditInsert(d1, auditValues(context, auditId, createdAt, "SUCCESS")),
    ]);
    const created = await db.servicePackage.findUnique({ where: { id }, include: { items: true } });
    if (!created) throw new Error("CARE service package was not readable after atomic creation");
    return created;
  }
  return db.$transaction(async (tx) => {
    const created = await tx.servicePackage.create({ data: input });
    await tx.auditLog.create({ data: {
      id: auditId, adminId: actor.id, action: context.action, entity: context.entity, entityId: id,
      before: null, after: auditEnvelope(context, "SUCCESS"), ipAddress: req.headers.get("cf-connecting-ip"),
      userAgent: req.headers.get("user-agent"),
    } });
    return created;
  });
}

export async function createMaintenanceRuleWithAudit(
  db: PrismaClient, input: MaintenanceRuleInput, actor: AuditActor, req: Request
) {
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const snapshot = { id, brand: input.brand, model: input.model, yearFrom: input.yearFrom, yearTo: input.yearTo,
    engine: input.engine, mileageInterval: input.mileageInterval, timeInterval: input.timeInterval,
    category: input.category, priority: input.priority, version: input.version, active: true };
  const context: AuditContext = { actor, req, action: "CREATE_CARE_MAINTENANCE_RULE", entity: "MaintenanceRule", entityId: id, snapshot };
  const auditId = `audit_care_rule_${id}`;
  if (isWorker()) {
    const d1 = await getD1Binding() as unknown as D1Database;
    await d1.batch([
      d1.prepare('INSERT INTO "MaintenanceRule" ("id","brand","model","yearFrom","yearTo","engine","mileageInterval","timeInterval","category","priority","version","active","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, input.brand, input.model, input.yearFrom, input.yearTo, input.engine, input.mileageInterval, input.timeInterval,
          input.category, input.priority, input.version, true, createdAt, createdAt),
      d1AuditInsert(d1, auditValues(context, auditId, createdAt, "SUCCESS")),
    ]);
    const created = await db.maintenanceRule.findUnique({ where: { id } });
    if (!created) throw new Error("CARE maintenance rule was not readable after atomic creation");
    return created;
  }
  return db.$transaction(async (tx) => {
    const created = await tx.maintenanceRule.create({ data: input });
    await tx.auditLog.create({ data: {
      id: auditId, adminId: actor.id, action: context.action, entity: context.entity, entityId: id,
      before: null, after: auditEnvelope(context, "SUCCESS"), ipAddress: req.headers.get("cf-connecting-ip"),
      userAgent: req.headers.get("user-agent"),
    } });
    return created;
  });
}

export async function writeMechanicReviewClaimAudit(
  db: PrismaClient, input: { applicationId: string; expectedStatus: "PENDING"; nextStatus: "APPROVING" | "REJECTING"; actor: AuditActor; req: Request }
): Promise<number> {
  const { applicationId, expectedStatus, nextStatus, actor, req } = input;
  const action = nextStatus === "APPROVING" ? "APPROVE_MECHANIC_APPLICATION_STARTED" : "REJECT_MECHANIC_APPLICATION_STARTED";
  const auditId = `audit_mechanic_${applicationId}_${nextStatus.toLowerCase()}`;
  const createdAt = new Date().toISOString();
  const context: AuditContext = {
    actor, req, action, entity: "MechanicApplication", entityId: applicationId,
    snapshot: { id: applicationId, fromStatus: expectedStatus, toStatus: nextStatus },
  };
  if (isWorker()) {
    const d1 = await getD1Binding() as unknown as D1Database;
    await d1.batch([
      d1.prepare('UPDATE "MechanicApplication" SET "status" = ?, "reviewerId" = ? WHERE "id" = ? AND "status" = ?')
        .bind(nextStatus, actor.id, applicationId, expectedStatus),
      d1.prepare('INSERT OR IGNORE INTO "AuditLog" ("id","adminId","action","entity","entityId","before","after","ipAddress","userAgent","createdAt") SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes() = 1')
        .bind(...auditValues(context, auditId, createdAt, "IN_PROGRESS")),
    ]);
    const current = await db.mechanicApplication.findUnique({ where: { id: applicationId } });
    return current?.status === nextStatus && current?.reviewerId === actor.id ? 1 : 0;
  }
  return db.$transaction(async (tx) => {
    const claim = await tx.mechanicApplication.updateMany({
      where: { id: applicationId, status: expectedStatus },
      data: { status: nextStatus, reviewerId: actor.id },
    });
    if (claim.count === 1) {
      await tx.auditLog.create({ data: {
        id: auditId, adminId: actor.id, action, entity: "MechanicApplication", entityId: applicationId,
        before: JSON.stringify({ status: expectedStatus }),
        after: auditEnvelope(context, "IN_PROGRESS"),
        ipAddress: req.headers.get("cf-connecting-ip"), userAgent: req.headers.get("user-agent"),
      } });
    }
    return claim.count;
  });
}

export async function finalizeMechanicApprovalWithAudit(
  db: PrismaClient,
  input: { applicationId: string; userId: string; actor: AuditActor; req: Request; notes: string | null }
): Promise<{ ok: boolean; finalized: boolean }> {
  const { applicationId, userId, actor, req, notes } = input;
  const auditId = `audit_mechanic_${applicationId}_approved`;
  const createdAt = new Date().toISOString();
  const context: AuditContext = {
    actor, req, action: "APPROVE_MECHANIC_APPLICATION", entity: "MechanicApplication", entityId: applicationId,
    snapshot: { id: applicationId, status: "APPROVED", technicianUserId: userId },
  };

  if (isWorker()) {
    const d1 = await getD1Binding() as unknown as D1Database;
    const before = await db.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (!before || (before.status !== "APPROVING" && before.status !== "APPROVED")) return { ok: false, finalized: false };
    await d1.batch([
      d1.prepare('UPDATE "User" SET "role" = ? WHERE "id" = ? AND "status" <> ? AND "role" IN (?, ?)')
        .bind("TECHNICIAN", userId, "SUSPENDED", "CUSTOMER", "TECHNICIAN"),
      d1AssertOneChange(d1),
      d1.prepare('UPDATE "MechanicApplication" SET "status" = ?, "userId" = ?, "reviewerId" = ?, "reviewedAt" = ?, "adminNotes" = ? WHERE "id" = ? AND "status" IN (?, ?) AND ("userId" IS NULL OR "userId" = ?)')
        .bind("APPROVED", userId, actor.id, createdAt, notes, applicationId, "APPROVING", "APPROVED", userId),
      d1AssertOneChange(d1),
      d1.prepare('INSERT OR IGNORE INTO "AuditLog" ("id","adminId","action","entity","entityId","before","after","ipAddress","userAgent","createdAt") SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM "MechanicApplication" WHERE "id" = ? AND "status" = ? AND "userId" = ?) AND EXISTS (SELECT 1 FROM "User" WHERE "id" = ? AND "role" = ? AND "status" <> ?)')
        .bind(...auditValues(context, auditId, createdAt, "SUCCESS"), applicationId, "APPROVED", userId, userId, "TECHNICIAN", "SUSPENDED"),
    ]);
    const [application, user] = await Promise.all([
      db.mechanicApplication.findUnique({ where: { id: applicationId } }),
      db.user.findUnique({ where: { id: userId } }),
    ]);
    return {
      ok: application?.status === "APPROVED" && application?.userId === userId &&
        user?.role === "TECHNICIAN" && user?.status !== "SUSPENDED",
      finalized: before.status === "APPROVING",
    };
  }

  return db.$transaction(async (tx) => {
    const application = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (!application || (application.status !== "APPROVING" && application.status !== "APPROVED") ||
      (application.userId && application.userId !== userId)) {
      return { ok: false, finalized: false };
    }
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.status === "SUSPENDED" || (user.role !== "CUSTOMER" && user.role !== "TECHNICIAN")) {
      return { ok: false, finalized: false };
    }
    if (user.role === "CUSTOMER") {
      const promoted = await tx.user.updateMany({
        where: { id: userId, role: "CUSTOMER", status: { not: "SUSPENDED" } },
        data: { role: "TECHNICIAN" },
      });
      if (promoted.count !== 1) {
        const current = await tx.user.findUnique({ where: { id: userId } });
        if (current?.role !== "TECHNICIAN" || current.status === "SUSPENDED") {
          throw new Error("Mechanic account promotion conflicted during atomic audit finalization");
        }
      }
    }
    if (application.status === "APPROVING") {
      const finalized = await tx.mechanicApplication.updateMany({
        where: { id: applicationId, status: "APPROVING" },
        data: { status: "APPROVED", userId, reviewerId: actor.id, reviewedAt: new Date(createdAt), adminNotes: notes },
      });
      if (finalized.count !== 1) {
        const current = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
        if (current?.status !== "APPROVED" || current.userId !== userId) {
          throw new Error("Mechanic application approval conflicted during atomic audit finalization");
        }
      }
    } else if (!application.userId) {
      await tx.mechanicApplication.updateMany({
        where: { id: applicationId, status: "APPROVED", userId: null },
        data: { userId, reviewerId: actor.id },
      });
    }
    const linkedApplication = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (linkedApplication?.status !== "APPROVED" || linkedApplication.userId !== userId) {
      throw new Error("Mechanic application user link conflicted during atomic audit finalization");
    }
    await tx.auditLog.upsert({
      where: { id: auditId },
      create: {
        id: auditId, adminId: actor.id, action: context.action, entity: context.entity, entityId: applicationId,
        before: JSON.stringify({ status: application.status }), after: auditEnvelope(context, "SUCCESS"),
        ipAddress: req.headers.get("cf-connecting-ip"), userAgent: req.headers.get("user-agent"),
      },
      update: {},
    });
    return { ok: true, finalized: application.status === "APPROVING" };
  });
}

export async function finalizeMechanicRejectionWithAudit(
  db: PrismaClient,
  input: { applicationId: string; actor: AuditActor; req: Request; notes: string | null }
): Promise<{ ok: boolean; finalized: boolean }> {
  const { applicationId, actor, req, notes } = input;
  const auditId = `audit_mechanic_${applicationId}_rejected`;
  const createdAt = new Date().toISOString();
  const context: AuditContext = {
    actor, req, action: "REJECT_MECHANIC_APPLICATION", entity: "MechanicApplication", entityId: applicationId,
    snapshot: { id: applicationId, status: "REJECTED" },
  };

  if (isWorker()) {
    const d1 = await getD1Binding() as unknown as D1Database;
    const before = await db.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (!before || (before.status !== "REJECTING" && before.status !== "REJECTED")) return { ok: false, finalized: false };
    await d1.batch([
      d1.prepare('UPDATE "MechanicApplication" SET "status" = ?, "reviewerId" = ?, "reviewedAt" = ?, "adminNotes" = ? WHERE "id" = ? AND "status" = ?')
        .bind("REJECTED", actor.id, createdAt, notes, applicationId, "REJECTING"),
      d1.prepare('INSERT OR IGNORE INTO "AuditLog" ("id","adminId","action","entity","entityId","before","after","ipAddress","userAgent","createdAt") SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM "MechanicApplication" WHERE "id" = ? AND "status" = ? AND "reviewerId" = ?)')
        .bind(...auditValues(context, auditId, createdAt, "SUCCESS"), applicationId, "REJECTED", actor.id),
    ]);
    const current = await db.mechanicApplication.findUnique({ where: { id: applicationId } });
    return { ok: current?.status === "REJECTED" && current?.reviewerId === actor.id, finalized: before.status === "REJECTING" };
  }

  return db.$transaction(async (tx) => {
    const application = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (!application || (application.status !== "REJECTING" && application.status !== "REJECTED")) {
      return { ok: false, finalized: false };
    }
    if (application.status === "REJECTING") {
      const finalized = await tx.mechanicApplication.updateMany({
        where: { id: applicationId, status: "REJECTING" },
        data: { status: "REJECTED", reviewerId: actor.id, reviewedAt: new Date(createdAt), adminNotes: notes },
      });
      if (finalized.count !== 1) {
        const current = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
        if (current?.status !== "REJECTED" || current.reviewerId !== actor.id) {
          throw new Error("Mechanic application rejection conflicted during atomic audit finalization");
        }
      }
    }
    const finalApplication = await tx.mechanicApplication.findUnique({ where: { id: applicationId } });
    if (finalApplication?.status !== "REJECTED" || finalApplication.reviewerId !== actor.id) {
      throw new Error("Mechanic application rejection audit could not be linked to the final decision");
    }
    await tx.auditLog.upsert({
      where: { id: auditId },
      create: {
        id: auditId, adminId: actor.id, action: context.action, entity: context.entity, entityId: applicationId,
        before: JSON.stringify({ status: application.status }), after: auditEnvelope(context, "SUCCESS"),
        ipAddress: req.headers.get("cf-connecting-ip"), userAgent: req.headers.get("user-agent"),
      },
      update: {},
    });
    return { ok: true, finalized: application.status === "REJECTING" };
  });
}
