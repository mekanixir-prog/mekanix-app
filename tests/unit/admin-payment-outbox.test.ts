// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAdmin, mockFindMany, mockCount } = vi.hoisted(() => ({
  mockGetAdmin: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: (...args: unknown[]) => mockGetAdmin(...args),
}));

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    paymentOutboxEvent: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
  })),
}));

import { GET } from "@/app/api/admin/payment-outbox/route";

function request(query = "") {
  return new Request(`https://mekanix.test/api/admin/payment-outbox${query}`);
}

describe("GET /api/admin/payment-outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdmin.mockResolvedValue({ adminId: "admin-1", username: "ops", role: "ADMIN" });
    mockFindMany.mockResolvedValue([{
      id: "event-1",
      eventType: "PAYMENT_SUCCEEDED",
      aggregateType: "Payment",
      aggregateId: "payment-1",
      idempotencyKey: "payment.succeeded:gateway-1",
      status: "DEAD",
      attempts: 8,
      availableAt: new Date("2026-11-08T10:00:00.000Z"),
      lockedAt: null,
      processedAt: null,
      lastError: "worker failed\u0000 with database error",
      createdAt: new Date("2026-11-08T09:00:00.000Z"),
      updatedAt: new Date("2026-11-08T10:00:00.000Z"),
    }]);
    mockCount.mockImplementation(async ({ where }: { where?: { status?: string } } = {}) => ({
      PENDING: 2,
      PROCESSING: 1,
      PROCESSED: 9,
      DEAD: 3,
    }[where?.status ?? "PENDING"] ?? 15));
  });

  it("requires an authenticated admin and does not query the outbox when unauthenticated", async () => {
    mockGetAdmin.mockResolvedValue(null);
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("returns bounded metadata, summary counts, and pagination without exposing event payloads", async () => {
    const response = await GET(request("?status=DEAD&page=2&limit=10"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.readOnly).toBe(true);
    expect(body.summary).toEqual({ pending: 2, processing: 1, processed: 9, dead: 3 });
    expect(body.pagination).toEqual({ page: 2, limit: 10, total: 3, totalPages: 1 });
    expect(body.events[0].id).toBe("event-1");
    expect(body.events[0].lastError).toBe("worker failed with database error");
    expect(body.events[0]).not.toHaveProperty("payload");

    const query = mockFindMany.mock.calls[0][0];
    expect(query.where).toEqual({ status: "DEAD" });
    expect(query.skip).toBe(10);
    expect(query.take).toBe(10);
    expect(query.select).not.toHaveProperty("payload");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unsupported statuses and invalid pagination before database access", async () => {
    expect((await GET(request("?status=FAILED"))).status).toBe(400);
    expect((await GET(request("?page=0"))).status).toBe(400);
    expect((await GET(request("?limit=101"))).status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the outbox store is unavailable", async () => {
    mockFindMany.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(request());

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("PAYMENT_OUTBOX_UNAVAILABLE");
  });
});
