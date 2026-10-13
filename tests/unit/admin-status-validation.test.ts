// MEKANIX — Admin Status Validation Tests (S3 fix verification)
// ============================================================================
// Verifies the S3 security fix in admin/[resource]/[id]/route.ts:
//   - User status is validated against the UserStatus enum BEFORE any DB write
//   - Invalid status values → 400 (no partial update)
//   - Valid status values (ACTIVE, SUSPENDED, PENDING) → accepted
//   - Non-string status → 400
//
// These tests exercise the validation logic in isolation by mocking getDbForLib
// so no actual DB connection is needed. The key invariant under test:
//   "An invalid status value must NEVER reach db.user.update"
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock getDbForLib — returns a mock PrismaClient whose methods are vi.fn()
// so we can assert they were (or were not) called.
const mockUserUpdate = vi.fn();
const mockCustomerFindUnique = vi.fn();
const mockCustomerUpdate = vi.fn();
const mockTechnicianUpdate = vi.fn();
const mockReviewUpdate = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockServiceCategoryUpdate = vi.fn();

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn().mockResolvedValue({
    user: { update: mockUserUpdate },
    customer: { findUnique: mockCustomerFindUnique, update: mockCustomerUpdate },
    technician: { update: mockTechnicianUpdate },
    review: { update: mockReviewUpdate },
    payment: { update: mockPaymentUpdate },
    serviceCategory: { update: mockServiceCategoryUpdate },
  }),
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

// Helper: build a fake Next.js Request for PATCH
function makePatchRequest(resource: string, id: string, body: Record<string, any>): Request {
  return new Request(`http://localhost/api/admin/${resource}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Import AFTER mocks are set up
const { PATCH } = await import("@/app/api/admin/[resource]/[id]/route");

describe("S3 fix — admin/[resource]/[id] status validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // customer.findUnique returns a customer linked to a user
    mockCustomerFindUnique.mockResolvedValue({ userId: "user-1" });
    // update operations return their data arg
    mockUserUpdate.mockResolvedValue({});
    mockCustomerUpdate.mockResolvedValue({ id: "cust-1", user: { id: "user-1", status: "ACTIVE" } });
  });

  it("accepts status: ACTIVE", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: "ACTIVE" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "ACTIVE" } })
    );
  });

  it("accepts status: SUSPENDED", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: "SUSPENDED" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SUSPENDED" } })
    );
  });

  it("accepts status: PENDING", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: "PENDING" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "PENDING" } })
    );
  });

  it("rejects invalid string status with 400", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: "BANNED" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(400);
    // CRITICAL: db.user.update must NOT be called for invalid status
    expect(mockUserUpdate).not.toHaveBeenCalled();
    // And customer.update must not be called either (no partial update)
    expect(mockCustomerUpdate).not.toHaveBeenCalled();
  });

  it("rejects non-string status (number) with 400", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: 123 });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockCustomerUpdate).not.toHaveBeenCalled();
  });

  it("rejects non-string status (null) with 400", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: null });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("rejects non-string status (boolean) with 400", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: true });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("rejects empty string status with 400", async () => {
    const req = makePatchRequest("customers", "cust-1", { status: "" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("allows customers update WITHOUT status (no validation needed)", async () => {
    const req = makePatchRequest("customers", "cust-1", { company: "ACME Corp" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) });
    expect(res.status).toBe(200);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockCustomerUpdate).toHaveBeenCalled();
  });

  it("does NOT validate status for non-customers resources", async () => {
    // Technicians have a 'status' field too, but it's a different enum (TechnicianStatus).
    // The S3 fix only validates UserStatus for the customers resource.
    mockTechnicianUpdate.mockResolvedValue({ id: "tech-1" });
    const req = makePatchRequest("technicians", "tech-1", { status: "ONLINE" });
    const res = await PATCH(req, { params: Promise.resolve({ resource: "technicians", id: "tech-1" }) });
    expect(res.status).toBe(200);
    expect(mockUserUpdate).not.toHaveBeenCalled();
    expect(mockTechnicianUpdate).toHaveBeenCalled();
  });

  it("mid-failure: user.status update fires BEFORE customer.update (security-critical ordering)", async () => {
    // This test verifies the ORDER of operations, not the error handling.
    // If customer.update throws, the error propagates — but the key invariant
    // is that user.update was called FIRST (the ban took effect before any
    // customer-profile failure could abort the operation).
    mockUserUpdate.mockResolvedValue({});
    mockCustomerUpdate.mockRejectedValue(new Error("DB write failed"));

    const req = makePatchRequest("customers", "cust-1", { status: "SUSPENDED", company: "Test" });

    // The request will reject because customer.update throws — wrap in try/catch
    await expect(
      PATCH(req, { params: Promise.resolve({ resource: "customers", id: "cust-1" }) })
    ).rejects.toThrow("DB write failed");

    // CRITICAL INVARIANT: user.update WAS called (the ban took effect)
    // BEFORE customer.update failed. This is the security-critical ordering.
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SUSPENDED" } })
    );
    // And customer.update was attempted (after user.update)
    expect(mockCustomerUpdate).toHaveBeenCalled();

    // Verify call order: user.update called before customer.update
    const userUpdateOrder = mockUserUpdate.mock.invocationCallOrder[0];
    const customerUpdateOrder = mockCustomerUpdate.mock.invocationCallOrder[0];
    expect(userUpdateOrder).toBeLessThan(customerUpdateOrder);
  });
});
