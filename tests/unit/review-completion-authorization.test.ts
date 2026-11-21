// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireJobParticipant: vi.fn(),
  getCustomerFromSession: vi.fn(),
  jobFindUnique: vi.fn(),
  reviewFindFirst: vi.fn(),
  reviewCreate: vi.fn(),
  reviewFindMany: vi.fn(),
  technicianUpdate: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/auth", () => ({
  requireJobParticipant: mocks.requireJobParticipant,
  getCustomerFromSession: mocks.getCustomerFromSession,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    job: { findUnique: mocks.jobFindUnique },
    review: {
      findFirst: mocks.reviewFindFirst,
      create: mocks.reviewCreate,
      findMany: mocks.reviewFindMany,
    },
    technician: { update: mocks.technicianUpdate },
  })),
}));
vi.mock("@/lib/user-select", () => ({ PARTICIPANT_USER_SELECT: { id: true, name: true } }));

import { POST } from "@/app/api/reviews/route";

const makeRequest = (body: unknown) => new Request("https://mekanix.test/api/reviews", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const validBody = () => ({ jobId: "job-1", technicianId: "tech-1", rating: 5, comment: "Great", tags: ["on-time"] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "customer-user", role: "CUSTOMER" });
  mocks.requireJobParticipant.mockResolvedValue(null);
  mocks.getCustomerFromSession.mockResolvedValue({ id: "customer-1" });
  mocks.jobFindUnique.mockResolvedValue({
    status: "COMPLETED",
    customerApproved: true,
    request: { customerId: "customer-1" },
    technicianId: "tech-1",
  });
  mocks.reviewFindFirst.mockResolvedValue(null);
  mocks.reviewCreate.mockResolvedValue({ id: "review-1", rating: 5 });
  mocks.reviewFindMany.mockResolvedValue([{ rating: 5 }, { rating: 4 }]);
  mocks.technicianUpdate.mockResolvedValue({ id: "tech-1" });
});

describe("POST /api/reviews lifecycle and authorization", () => {
  it.each(["ADMIN", "TECHNICIAN", "FLEET_MANAGER", "PARTNER"])(
    "rejects non-customer role %s",
    async (role) => {
      mocks.requireAuth.mockResolvedValue({ userId: "user-1", role });
      const response = await POST(makeRequest(validBody()));
      expect(response.status).toBe(403);
      expect(mocks.reviewCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["IN_PROGRESS", true],
    ["COMPLETED", false],
  ])("rejects job status=%s approved=%s", async (status, approved) => {
    mocks.jobFindUnique.mockResolvedValue({
      status,
      customerApproved: approved,
      request: { customerId: "customer-1" },
      technicianId: "tech-1",
    });
    const response = await POST(makeRequest(validBody()));
    expect(response.status).toBe(409);
    expect(mocks.reviewCreate).not.toHaveBeenCalled();
  });

  it("rejects a review when the caller does not own the job", async () => {
    mocks.jobFindUnique.mockResolvedValue({
      status: "COMPLETED",
      customerApproved: true,
      request: { customerId: "another-customer" },
      technicianId: "tech-1",
    });
    const response = await POST(makeRequest(validBody()));
    expect(response.status).toBe(403);
    expect(mocks.reviewCreate).not.toHaveBeenCalled();
  });

  it("rejects a technician ID that does not match the assigned technician", async () => {
    const response = await POST(makeRequest({ ...validBody(), technicianId: "other-tech" }));
    expect(response.status).toBe(400);
    expect(mocks.reviewCreate).not.toHaveBeenCalled();
  });

  it("normalizes the unique-index race into a conflict response", async () => {
    mocks.reviewCreate.mockRejectedValue({ code: "P2002" });
    const response = await POST(makeRequest(validBody()));
    expect(response.status).toBe(409);
    expect(mocks.technicianUpdate).not.toHaveBeenCalled();
  });

  it("creates a review only after completion and updates the technician aggregate", async () => {
    const response = await POST(makeRequest(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.reviewCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        jobId: "job-1",
        technicianId: "tech-1",
        fromUserId: "customer-user",
        rating: 5,
        tags: JSON.stringify(["on-time"]),
      }),
    }));
    expect(mocks.technicianUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "tech-1" },
      data: expect.objectContaining({ rating: 4.5, reviewCount: 2, completedJobs: { increment: 1 } }),
    }));
  });
});
