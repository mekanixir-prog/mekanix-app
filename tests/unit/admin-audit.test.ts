// @vitest-environment node
// MEKANIX — SEC-4 Admin Audit Log Tests (Bundle 3)
// ============================================================================
// Verifies the SEC-4 fix in src/app/api/admin/[resource]/[id]/route.ts:
//   1. PATCH /api/admin/technicians/:id creates AuditLog with action UPDATE_TECHNICIAN
//   2. PATCH /api/admin/customers/:id with status creates AuditLog with CHANGE_USER_STATUS
//   3. Audit log failure does NOT block the mutation (best-effort audit)
//
// Additional coverage:
//   - PATCH categories → UPDATE_CATEGORY
//   - PATCH reviews → UPDATE_REVIEW
//   - PATCH payments → UPDATE_PAYMENT
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────── Module-level mocks (hoisted by vitest) ────────────
const mockTechnicianFindUnique = vi.fn();
const mockTechnicianUpdate = vi.fn();
const mockCustomerFindUnique = vi.fn();
const mockCustomerUpdate = vi.fn();
const mockUserFindUnique = vi.fn();
const mockUserUpdate = vi.fn();
const mockServiceCategoryFindUnique = vi.fn();
const mockServiceCategoryUpdate = vi.fn();
const mockReviewFindUnique = vi.fn();
const mockReviewUpdate = vi.fn();
const mockPaymentFindUnique = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockAuditLogCreate = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    technician: {
      findUnique: (...args: any[]) => mockTechnicianFindUnique(...args),
      update: (...args: any[]) => mockTechnicianUpdate(...args),
    },
    customer: {
      findUnique: (...args: any[]) => mockCustomerFindUnique(...args),
      update: (...args: any[]) => mockCustomerUpdate(...args),
    },
    user: {
      findUnique: (...args: any[]) => mockUserFindUnique(...args),
      update: (...args: any[]) => mockUserUpdate(...args),
    },
    serviceCategory: {
      findUnique: (...args: any[]) => mockServiceCategoryFindUnique(...args),
      update: (...args: any[]) => mockServiceCategoryUpdate(...args),
    },
    review: {
      findUnique: (...args: any[]) => mockReviewFindUnique(...args),
      update: (...args: any[]) => mockReviewUpdate(...args),
    },
    payment: {
      findUnique: (...args: any[]) => mockPaymentFindUnique(...args),
      update: (...args: any[]) => mockPaymentUpdate(...args),
    },
    auditLog: { create: (...args: any[]) => mockAuditLogCreate(...args) },
  })),
}));

// Mock auth helpers — requireAuth returns a valid ADMIN session
vi.mock("@/lib/api-helpers", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    userId: "admin-1",
    role: "ADMIN",
    phone: null,
    isGuest: false,
  }),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual("@/lib/auth");
  return {
    ...actual,
    requireRole: vi.fn().mockReturnValue(null), // null = allowed
  };
});

// Mock writeAuditLog — controllable per-test
const mockWriteAuditLog = vi.fn();
vi.mock("@/lib/admin-api", () => ({
  writeAuditLog: (...args: any[]) => mockWriteAuditLog(...args),
  getPagination: vi.fn(),
  getQuery: vi.fn(),
  daysAgo: vi.fn(),
}));

// ──────────── Import route handler (after mocks hoisted) ────────────
import { PATCH } from "@/app/api/admin/[resource]/[id]/route";

// ──────────── Helpers ────────────
function makePatchRequest(resource: string, id: string, body: Record<string, any>): Request {
  return new Request(`http://localhost/api/admin/${resource}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockAuditLogCreate.mockResolvedValue({});
});

describe("SEC-4 — admin PATCH audit logging", () => {
  // ──────────── 1. technicians → UPDATE_TECHNICIAN ────────────
  it("PATCH /api/admin/technicians/:id creates AuditLog with action UPDATE_TECHNICIAN", async () => {
    const before = { id: "tech-1", bio: "old bio", hourlyRate: 50 };
    const after = { id: "tech-1", bio: "new bio", hourlyRate: 75, user: { id: "user-1" } };
    mockTechnicianFindUnique.mockResolvedValue(before);
    mockTechnicianUpdate.mockResolvedValue(after);

    const req = makePatchRequest("technicians", "tech-1", { bio: "new bio", hourlyRate: 75 });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "technicians", id: "tech-1" }) });

    expect(res.status).toBe(200);

    // writeAuditLog was called with action UPDATE_TECHNICIAN
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    const args = mockWriteAuditLog.mock.calls[0][0];
    expect(args.action).toBe("UPDATE_TECHNICIAN");
    expect(args.entity).toBe("technician");
    expect(args.entityId).toBe("tech-1");
    expect(args.before).toEqual(before);
    expect(args.after).toEqual(after);
  });

  // ──────────── 2. customers with status → CHANGE_USER_STATUS ────────────
  it("PATCH /api/admin/customers/:id with status creates AuditLog with CHANGE_USER_STATUS", async () => {
    const beforeCustomer = { id: "cust-1", userId: "user-1", company: "Old Co" };
    const afterCustomer = { id: "cust-1", userId: "user-1", company: "New Co", user: { id: "user-1", status: "SUSPENDED" } };
    const beforeUser = { id: "user-1", status: "ACTIVE" };

    // customer.findUnique is called twice: once for the userId lookup (select userId),
    // once for the before-snapshot of the customer record.
    mockCustomerFindUnique
      .mockResolvedValueOnce({ userId: "user-1" }) // userId lookup (for user.status update)
      .mockResolvedValueOnce(beforeCustomer); // before-snapshot
    mockUserFindUnique.mockResolvedValue(beforeUser);
    mockUserUpdate.mockResolvedValue({});
    mockCustomerUpdate.mockResolvedValue(afterCustomer);

    const req = makePatchRequest("customers", "cust-1", { status: "SUSPENDED", company: "New Co" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });

    expect(res.status).toBe(200);

    // CHANGE_USER_STATUS audit log entry was created (for the user.status update)
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHANGE_USER_STATUS",
        entity: "user",
        entityId: "user-1",
      })
    );

    // UPDATE_CUSTOMER audit log entry was also created (for the customer profile update)
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_CUSTOMER",
        entity: "customer",
        entityId: "cust-1",
      })
    );

    // Total: 2 audit log entries (CHANGE_USER_STATUS + UPDATE_CUSTOMER)
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(2);
  });

  // ──────────── 3. Audit log failure does NOT block mutation ────────────
  it("audit log failure does NOT block the mutation (best-effort audit)", async () => {
    // writeAuditLog rejects — but the PATCH should still succeed
    mockWriteAuditLog.mockRejectedValue(new Error("audit log service down"));
    const before = { id: "tech-1", bio: "old" };
    const after = { id: "tech-1", bio: "new", user: { id: "user-1" } };
    mockTechnicianFindUnique.mockResolvedValue(before);
    mockTechnicianUpdate.mockResolvedValue(after);

    const req = makePatchRequest("technicians", "tech-1", { bio: "new" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "technicians", id: "tech-1" }) });

    // CRITICAL: the PATCH succeeds even though audit log failed
    expect(res.status).toBe(200);
    // The DB update WAS applied
    expect(mockTechnicianUpdate).toHaveBeenCalledTimes(1);
    // writeAuditLog was attempted (even though it failed)
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
  });

  // ──────────── 4. categories → UPDATE_CATEGORY ────────────
  it("PATCH /api/admin/categories/:id creates AuditLog with action UPDATE_CATEGORY", async () => {
    const before = { id: "cat-1", name: "Old" };
    const after = { id: "cat-1", name: "New" };
    mockServiceCategoryFindUnique.mockResolvedValue(before);
    mockServiceCategoryUpdate.mockResolvedValue(after);

    const req = makePatchRequest("categories", "cat-1", { name: "New" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "categories", id: "cat-1" }) });

    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_CATEGORY",
        entity: "serviceCategory",
        entityId: "cat-1",
      })
    );
  });

  // ──────────── 5. reviews → UPDATE_REVIEW ────────────
  it("PATCH /api/admin/reviews/:id creates AuditLog with action UPDATE_REVIEW", async () => {
    const before = { id: "rev-1", status: "PENDING" };
    const after = { id: "rev-1", status: "PUBLISHED" };
    mockReviewFindUnique.mockResolvedValue(before);
    mockReviewUpdate.mockResolvedValue(after);

    const req = makePatchRequest("reviews", "rev-1", { status: "PUBLISHED" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "reviews", id: "rev-1" }) });

    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_REVIEW",
        entity: "review",
        entityId: "rev-1",
      })
    );
  });

  // ──────────── 6. payments → UPDATE_PAYMENT ────────────
  it("PATCH /api/admin/payments/:id creates AuditLog with action UPDATE_PAYMENT", async () => {
    const before = { id: "pay-1", status: "PENDING" };
    const after = { id: "pay-1", status: "REFUNDED" };
    mockPaymentFindUnique.mockResolvedValue(before);
    mockPaymentUpdate.mockResolvedValue(after);

    const req = makePatchRequest("payments", "pay-1", { status: "REFUNDED" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "payments", id: "pay-1" }) });

    expect(res.status).toBe(200);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_PAYMENT",
        entity: "payment",
        entityId: "pay-1",
      })
    );
  });

  // ──────────── 7. customers WITHOUT status → UPDATE_CUSTOMER only ────────────
  it("PATCH /api/admin/customers/:id WITHOUT status creates only UPDATE_CUSTOMER (no CHANGE_USER_STATUS)", async () => {
    const before = { id: "cust-2", userId: "user-2", company: "Old" };
    const after = { id: "cust-2", userId: "user-2", company: "New Co" };
    mockCustomerFindUnique.mockResolvedValueOnce(before); // before-snapshot only
    mockCustomerUpdate.mockResolvedValue(after);

    const req = makePatchRequest("customers", "cust-2", { company: "New Co" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-2" }) });

    expect(res.status).toBe(200);

    // Only UPDATE_CUSTOMER — no CHANGE_USER_STATUS (no status in body)
    expect(mockWriteAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_CUSTOMER",
        entity: "customer",
        entityId: "cust-2",
      })
    );
    // Verify CHANGE_USER_STATUS was NOT called
    const callArgs = mockWriteAuditLog.mock.calls.map((c) => c[0]);
    expect(callArgs.find((a) => a.action === "CHANGE_USER_STATUS")).toBeUndefined();
  });
});
