// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getD1Binding: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ getD1Binding: mocks.getD1Binding }));

import {
  createCarePackageWithAudit,
  finalizeMechanicApprovalWithAudit,
  createMaintenanceRuleWithAudit,
  redactAuditSnapshot,
  writeMechanicReviewClaimAudit,
} from "@/lib/admin-audit-atomic";

const actor = { id: "admin-user-7", role: "ADMIN" };
const req = new Request("https://mekanix.test/api/admin/write", {
  headers: { "x-request-id": "req-audit-test-001", "user-agent": "vitest" },
});

function prismaMock(overrides: Record<string, unknown> = {}) {
  const tx = {
    servicePackage: { create: vi.fn(async ({ data }) => ({ id: data.id, ...data })) },
    maintenanceRule: { create: vi.fn(async ({ data }) => ({ id: data.id, ...data })) },
    mechanicApplication: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id: "application-9", status: "APPROVING", userId: null })
        .mockResolvedValue({ id: "application-9", status: "APPROVED", userId: "tech-user-1", reviewerId: actor.id }),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: "tech-user-1", role: "CUSTOMER", status: "ACTIVE" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => ({ id: data.id })),
      upsert: vi.fn(async ({ create }) => ({ id: create.id })),
      findUnique: vi.fn(async () => null),
    },
  };
  return { tx, db: {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    servicePackage: { findUnique: vi.fn(async () => ({ id: "pkg-d1" })) },
    maintenanceRule: { findUnique: vi.fn(async () => ({ id: "rule-d1" })) },
    mechanicApplication: { findUnique: vi.fn(async () => ({ status: "APPROVING", reviewerId: actor.id, userId: null })) },
    user: { findUnique: vi.fn(async () => ({ id: "tech-user-1", role: "TECHNICIAN", status: "ACTIVE" })) },
    ...overrides,
  } };
}

describe("durable admin audit events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { userAgent: "node" });
  });

  it("redacts credentials and sensitive financial fields recursively", () => {
    expect(redactAuditSnapshot({
      id: "x",
      password: "never-store",
      basePrice: 500,
      nested: { otp: "123456", amount: 900, label: "safe" },
    })).toEqual({ id: "x", nested: { label: "safe" } });
  });

  it("commits a CARE package and its audit event in one Prisma transaction", async () => {
    const { db, tx } = prismaMock();
    const created = await createCarePackageWithAudit(db as never, {
      name: "Periodic", nameFa: "دوره‌ای", description: null, category: "periodic", basePrice: 1200, order: 2,
    }, actor, req);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.servicePackage.create.mock.calls[0][0].data.id).toBe(created.id);
    expect(tx.servicePackage.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const event = tx.auditLog.create.mock.calls[0][0].data;
    expect(event.entityId).toBe(created.id);
    expect(event.id).toBe(`audit_care_package_${created.id}`);
    const envelope = JSON.parse(event.after);
    expect(envelope.actor).toEqual(actor);
    expect(envelope.requestId).toBe("req-audit-test-001");
    expect(envelope.outcome).toBe("SUCCESS");
    expect(envelope.snapshot).not.toHaveProperty("basePrice");
  });

  it("rolls the transaction back when the audit insert fails", async () => {
    const { db, tx } = prismaMock();
    tx.auditLog.create.mockRejectedValue(new Error("audit unavailable"));
    await expect(createMaintenanceRuleWithAudit(db as never, {
      brand: "CAT", model: "320", yearFrom: 2020, yearTo: null, engine: null,
      mileageInterval: 500, timeInterval: 180, category: "oil", priority: "REQUIRED", version: "1.0",
    }, actor, req)).rejects.toThrow("audit unavailable");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.maintenanceRule.create).toHaveBeenCalledTimes(1);
  });

  it("uses one D1 batch for CARE rule creation and its audit event", async () => {
    const batch = vi.fn(async (_statements: unknown[]) => []);
    const prepare = vi.fn((sql: string) => ({ sql, bind: (...values: unknown[]) => ({ sql, values }) }));
    mocks.getD1Binding.mockResolvedValue({ prepare, batch });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const { db } = prismaMock();

    await createMaintenanceRuleWithAudit(db as never, {
      brand: "CAT", model: "320", yearFrom: 2020, yearTo: null, engine: null,
      mileageInterval: 500, timeInterval: 180, category: "oil", priority: "REQUIRED", version: "1.0",
    }, actor, req);

    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('INSERT INTO "MaintenanceRule"');
    expect(statements[1].sql).toContain('INSERT OR IGNORE INTO "AuditLog"');
  });

  it("writes the mechanic review claim and audit row in the same D1 batch", async () => {
    const batch = vi.fn(async (_statements: unknown[]) => []);
    const prepare = vi.fn((sql: string) => ({ sql, bind: (...values: unknown[]) => ({ sql, values }) }));
    mocks.getD1Binding.mockResolvedValue({ prepare, batch });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const { db } = prismaMock();
    db.mechanicApplication.findUnique.mockResolvedValue({ status: "REJECTING", reviewerId: actor.id, userId: null });

    const count = await writeMechanicReviewClaimAudit(db as never, {
      applicationId: "application-9", expectedStatus: "PENDING", nextStatus: "REJECTING", actor, req,
    });

    expect(count).toBe(1);
    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain('UPDATE "MechanicApplication"');
    expect(statements[1].sql).toContain('WHERE changes() = 1');
  });

  it("atomically finalizes technician promotion and the success audit in D1", async () => {
    const batch = vi.fn(async (_statements: unknown[]) => []);
    const prepare = vi.fn((sql: string) => ({ sql, bind: (...values: unknown[]) => ({ sql, values }) }));
    mocks.getD1Binding.mockResolvedValue({ prepare, batch });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const { db } = prismaMock();
    db.mechanicApplication.findUnique
      .mockResolvedValueOnce({ status: "APPROVING", userId: null, reviewerId: actor.id } as any)
      .mockResolvedValueOnce({ status: "APPROVED", userId: "tech-user-1", reviewerId: actor.id } as any);

    const result = await finalizeMechanicApprovalWithAudit(db as never, {
      applicationId: "application-9", userId: "tech-user-1", actor, req, notes: "internal note",
    });

    expect(result).toEqual({ ok: true, finalized: true });
    expect(batch).toHaveBeenCalledTimes(1);
    const statements = batch.mock.calls[0][0] as Array<{ sql: string }>;
    expect(statements).toHaveLength(5);
    expect(statements[0].sql).toContain('UPDATE "User"');
    expect(statements[2].sql).toContain('UPDATE "MechanicApplication"');
    expect(statements[4].sql).toContain('INSERT OR IGNORE INTO "AuditLog"');
  });

  it("finalizes technician promotion and audit in the same Prisma transaction", async () => {
    const { db, tx } = prismaMock();
    const result = await finalizeMechanicApprovalWithAudit(db as never, {
      applicationId: "application-9", userId: "tech-user-1", actor, req, notes: null,
    });

    expect(result).toEqual({ ok: true, finalized: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.mechanicApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "application-9", status: "APPROVING" },
      data: expect.objectContaining({ status: "APPROVED", userId: "tech-user-1" }),
    }));
    expect(tx.auditLog.upsert).toHaveBeenCalledTimes(1);
  });
});
