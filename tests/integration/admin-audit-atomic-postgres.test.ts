// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDbForLib } from "@/lib/db-access";
import {
  createCarePackageWithAudit,
  createMaintenanceRuleWithAudit,
  finalizeMechanicApprovalWithAudit,
  finalizeMechanicRejectionWithAudit,
  writeMechanicReviewClaimAudit,
} from "@/lib/admin-audit-atomic";

const postgresConfigured = process.env.DATABASE_URL?.startsWith("postgresql://") ?? false;

describe.skipIf(!postgresConfigured)("admin audit PostgreSQL atomicity integration", () => {
  const runId = crypto.randomUUID().replace(/-/g, "");
  let db: Awaited<ReturnType<typeof getDbForLib>> | null = null;
  let adminId = "";
  const userIds: string[] = [];
  const applicationIds: string[] = [];
  const packageIds: string[] = [];
  const ruleIds: string[] = [];
  const auditIds: string[] = [];

  const req = new Request("https://mekanix.test/api/admin/audit", {
    headers: { "x-request-id": `audit-pg-${runId}`, "user-agent": "vitest-postgres" },
  });

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "test");
    db = await getDbForLib();
    const admin = await db.user.create({
      data: { name: "Audit PG Admin", phone: `+9891${runId.slice(0, 9)}`, role: "ADMIN" },
    });
    adminId = admin.id;
    userIds.push(adminId);
  });

  afterAll(async () => {
    if (db) {
      await db.auditLog.deleteMany({ where: { id: { in: auditIds } } });
      await db.mechanicApplication.deleteMany({ where: { id: { in: applicationIds } } });
      await db.servicePackage.deleteMany({ where: { id: { in: packageIds } } });
      await db.maintenanceRule.deleteMany({ where: { id: { in: ruleIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    vi.unstubAllEnvs();
  });

  async function createCandidate(suffix: string) {
    const phoneSuffix = String(userIds.length).padStart(9, "0").slice(-9);
    const user = await db!.user.create({
      data: { name: `Audit PG Candidate ${suffix}`, phone: `+9892${phoneSuffix}`, role: "CUSTOMER" },
    });
    userIds.push(user.id);
    const application = await db!.mechanicApplication.create({
      data: {
        code: `AUDIT-PG-${runId}-${suffix}`,
        fullName: `Audit PG Candidate ${suffix}`,
        phone: `+9893${phoneSuffix}`,
        specialties: "[]",
        status: "PENDING",
      },
    });
    applicationIds.push(application.id);
    return { user, application };
  }

  async function withAuditInsertFailure<T>(condition: string, action: () => Promise<T>) {
    const token = crypto.randomUUID().replace(/-/g, "");
    const functionName = `audit_fail_${token}`;
    const triggerName = `audit_fail_trigger_${token}`;
    await db!.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected admin audit failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await db!.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "AuditLog"
      FOR EACH ROW WHEN (${condition})
      EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      return await action();
    } finally {
      await db!.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AuditLog"`);
      await db!.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  it("atomically records the approval claim, role promotion and final outcome", async () => {
    const { user, application } = await createCandidate("approve");
    const actor = { id: adminId, role: "ADMIN" };

    expect(await writeMechanicReviewClaimAudit(db as never, {
      applicationId: application.id, expectedStatus: "PENDING", nextStatus: "APPROVING", actor, req,
    })).toBe(1);

    const claimId = `audit_mechanic_${application.id}_approving`;
    auditIds.push(claimId);
    expect(await writeMechanicReviewClaimAudit(db as never, {
      applicationId: application.id, expectedStatus: "PENDING", nextStatus: "APPROVING", actor, req,
    })).toBe(0);
    expect(await db!.auditLog.count({ where: { id: claimId } })).toBe(1);
    const claim = await db!.auditLog.findUnique({ where: { id: claimId } });
    const claimEnvelope = JSON.parse(claim!.after!);
    expect(claimEnvelope.actor).toEqual(actor);
    expect(claimEnvelope.requestId).toBe(`audit-pg-${runId}`);
    expect(claimEnvelope.outcome).toBe("IN_PROGRESS");

    const result = await finalizeMechanicApprovalWithAudit(db as never, {
      applicationId: application.id, userId: user.id, actor, req, notes: "reviewed",
    });
    expect(result).toEqual({ ok: true, finalized: true });

    const [updatedApplication, updatedUser] = await Promise.all([
      db!.mechanicApplication.findUnique({ where: { id: application.id } }),
      db!.user.findUnique({ where: { id: user.id } }),
    ]);
    expect(updatedApplication?.status).toBe("APPROVED");
    expect(updatedApplication?.userId).toBe(user.id);
    expect(updatedUser?.role).toBe("TECHNICIAN");

    const finalId = `audit_mechanic_${application.id}_approved`;
    auditIds.push(finalId);
    const finalEvent = await db!.auditLog.findUnique({ where: { id: finalId } });
    const finalEnvelope = JSON.parse(finalEvent!.after!);
    expect(finalEnvelope.actor).toEqual(actor);
    expect(finalEnvelope.outcome).toBe("SUCCESS");
    expect(finalEnvelope.snapshot).toMatchObject({ id: application.id, status: "APPROVED", technicianUserId: user.id });
    expect(await finalizeMechanicApprovalWithAudit(db as never, {
      applicationId: application.id, userId: user.id, actor, req, notes: "reviewed",
    })).toEqual({ ok: true, finalized: false });
    expect(await db!.auditLog.count({ where: { id: finalId } })).toBe(1);
  });

  it("rolls back approval state and role promotion when the final audit insert fails", async () => {
    const { user, application } = await createCandidate("approve-rollback");
    const actor = { id: adminId, role: "ADMIN" };
    await writeMechanicReviewClaimAudit(db as never, {
      applicationId: application.id, expectedStatus: "PENDING", nextStatus: "APPROVING", actor, req,
    });
    const claimId = `audit_mechanic_${application.id}_approving`;
    auditIds.push(claimId);
    const finalId = `audit_mechanic_${application.id}_approved`;

    await withAuditInsertFailure(`NEW."id" = '${finalId}'`, async () => {
      await expect(finalizeMechanicApprovalWithAudit(db as never, {
        applicationId: application.id, userId: user.id, actor, req, notes: null,
      })).rejects.toThrow("injected admin audit failure");
    });

    const [updatedApplication, updatedUser, finalEvent] = await Promise.all([
      db!.mechanicApplication.findUnique({ where: { id: application.id } }),
      db!.user.findUnique({ where: { id: user.id } }),
      db!.auditLog.findUnique({ where: { id: finalId } }),
    ]);
    expect(updatedApplication?.status).toBe("APPROVING");
    expect(updatedUser?.role).toBe("CUSTOMER");
    expect(finalEvent).toBeNull();
  });

  it("atomically records the rejection decision and success outcome", async () => {
    const { application } = await createCandidate("reject");
    const actor = { id: adminId, role: "ADMIN" };
    expect(await writeMechanicReviewClaimAudit(db as never, {
      applicationId: application.id, expectedStatus: "PENDING", nextStatus: "REJECTING", actor, req,
    })).toBe(1);
    const claimId = `audit_mechanic_${application.id}_rejecting`;
    const finalId = `audit_mechanic_${application.id}_rejected`;
    auditIds.push(claimId, finalId);

    const result = await finalizeMechanicRejectionWithAudit(db as never, {
      applicationId: application.id, actor, req, notes: "not qualified",
    });
    expect(result).toEqual({ ok: true, finalized: true });
    const [updated, event] = await Promise.all([
      db!.mechanicApplication.findUnique({ where: { id: application.id } }),
      db!.auditLog.findUnique({ where: { id: finalId } }),
    ]);
    expect(updated?.status).toBe("REJECTED");
    expect(JSON.parse(event!.after!).outcome).toBe("SUCCESS");
    expect(await finalizeMechanicRejectionWithAudit(db as never, {
      applicationId: application.id, actor, req, notes: "not qualified",
    })).toEqual({ ok: true, finalized: false });
    expect(await db!.auditLog.count({ where: { id: finalId } })).toBe(1);
  });

  it("persists CARE package/rule audit metadata and rolls back a rule if audit persistence fails", async () => {
    const actor = { id: adminId, role: "ADMIN" };
    const pkg = await createCarePackageWithAudit(db as never, {
      name: `Audit package ${runId}`, nameFa: "بسته ممیزی", description: null,
      category: "periodic", basePrice: 950000, order: 1,
    }, actor, req);
    packageIds.push(pkg.id);
    const packageEventId = `audit_care_package_${pkg.id}`;
    auditIds.push(packageEventId);
    const packageEvent = await db!.auditLog.findUnique({ where: { id: packageEventId } });
    const packageEnvelope = JSON.parse(packageEvent!.after!);
    expect(packageEnvelope.actor).toEqual(actor);
    expect(packageEnvelope.requestId).toBe(`audit-pg-${runId}`);
    expect(packageEnvelope.outcome).toBe("SUCCESS");
    expect(packageEnvelope.snapshot).not.toHaveProperty("basePrice");

    const rule = await createMaintenanceRuleWithAudit(db as never, {
      brand: "CAT", model: "320", yearFrom: 2020, yearTo: 2025, engine: null,
      mileageInterval: 500, timeInterval: 180, category: "oil", priority: "REQUIRED", version: "1.0",
    }, actor, req);
    ruleIds.push(rule.id);
    auditIds.push(`audit_care_rule_${rule.id}`);
    expect(await db!.auditLog.findUnique({ where: { id: `audit_care_rule_${rule.id}` } })).not.toBeNull();

    const failedBrand = `AUDIT-FAIL-${runId}`;
    await withAuditInsertFailure("TRUE", async () => {
      await expect(createMaintenanceRuleWithAudit(db as never, {
        brand: failedBrand, model: null, yearFrom: null, yearTo: null, engine: null,
        mileageInterval: null, timeInterval: null, category: "inspection", priority: "REQUIRED", version: "1.0",
      }, actor, req)).rejects.toThrow("injected admin audit failure");
    });
    expect(await db!.maintenanceRule.count({ where: { brand: failedBrand } })).toBe(0);
  });
});
