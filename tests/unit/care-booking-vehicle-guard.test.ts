// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  validateBody: vi.fn(),
  customer: vi.fn(),
  vehicleFind: vi.fn(),
  calculatePrice: vi.fn(),
  createBooking: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.auth,
  validateBody: mocks.validateBody,
}));
vi.mock("@/lib/auth", () => ({ getCustomerFromSession: mocks.customer }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    vehicle: { findUnique: mocks.vehicleFind },
    serviceBooking: { findUnique: vi.fn().mockResolvedValue(null) },
  }),
}));
vi.mock("@/lib/pricing", () => ({ calculatePrice: mocks.calculatePrice }));
vi.mock("@/lib/care-booking-atomic", () => ({
  CareBookingIdempotencyConflict: class CareBookingIdempotencyConflict extends Error {},
  createCareBookingAtomically: mocks.createBooking,
}));

import { POST } from "@/app/api/care/bookings/route";

const body = {
  vehicleId: "vehicle-1",
  serviceType: "PERIODIC",
  location: "Tehran",
  date: "2026-11-10",
  timeWindow: "10:00-12:00",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "user-1", role: "CUSTOMER" });
  mocks.validateBody.mockResolvedValue({ ok: true, data: body });
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.vehicleFind.mockResolvedValue({
    id: "vehicle-1",
    customerId: "customer-1",
    type: "CAR",
    make: "Saipa",
    model: "Shahin",
  });
});

describe("CARE booking vehicle scope", () => {
  it("rejects out-of-scope passenger makes before pricing or booking writes", async () => {
    const response = await POST(new Request("https://mekanix.test/api/care/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": "care-booking-key-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VEHICLE_OUT_OF_SCOPE" });
    expect(mocks.calculatePrice).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });
});
