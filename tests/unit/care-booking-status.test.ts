// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  booking: vi.fn(),
  snapshot: vi.fn(),
  event: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    serviceBooking: { findUnique: mocks.booking },
    pricingSnapshot: { findUnique: mocks.snapshot },
    serviceTimelineEvent: { findUnique: mocks.event },
  }),
}));

import { GET } from "@/app/api/care/bookings/status/route";

const session = { userId: "user-1", role: "CUSTOMER" };
const booking = {
  id: "booking-1",
  code: "CARE-ABC123",
  userId: "user-1",
  requestFingerprint: "{...}",
  pricingSnapshotId: "snapshot-1",
};

function request(key = "care-booking-key-0001") {
  return new Request(`https://mekanix.test/api/care/bookings/status?key=${encodeURIComponent(key)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(session);
  mocks.booking.mockResolvedValue(booking);
  mocks.snapshot.mockResolvedValue({ id: "snapshot-1", bookingId: "booking-1" });
  mocks.event.mockResolvedValue({ id: "event-1", bookingId: "booking-1" });
});

describe("GET /api/care/bookings/status", () => {
  it("returns COMMITTED only when booking, pricing snapshot, and creation event agree", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "COMMITTED",
      booking: { id: "booking-1", code: "CARE-ABC123" },
    });
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      where: { bookingId: "booking-1" },
    }));
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: "care-booking:care-booking-key-0001:created" },
    }));
  });

  it("returns NOT_COMMITTED only when no booking exists for the key", async () => {
    mocks.booking.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "NOT_COMMITTED",
      retryAllowed: true,
    });
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
  });

  it("requires manual reconciliation when a dependent record is missing", async () => {
    mocks.snapshot.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "RECONCILIATION_REQUIRED",
      bookingCode: "CARE-ABC123",
    });
  });

  it("does not disclose a booking key owned by another user", async () => {
    mocks.booking.mockResolvedValue({ ...booking, userId: "user-2" });
    const response = await GET(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ state: "KEY_CONFLICT" });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("validates the key before querying the database", async () => {
    const response = await GET(request("x"));
    expect(response.status).toBe(400);
    expect(mocks.booking).not.toHaveBeenCalled();
  });
});
