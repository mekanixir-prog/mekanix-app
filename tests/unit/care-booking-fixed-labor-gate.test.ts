// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  validateBody: vi.fn(),
  customer: vi.fn(),
  fingerprint: vi.fn(),
  calculatePrice: vi.fn(),
  vip: vi.fn(),
  createAtomic: vi.fn(),
  vehicleFind: vi.fn(),
  bookingFind: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({
  requireAuth: mocks.auth,
  validateBody: mocks.validateBody,
}));
vi.mock("@/lib/auth", () => ({ getCustomerFromSession: mocks.customer }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    vehicle: { findUnique: mocks.vehicleFind },
    serviceBooking: { findUnique: mocks.bookingFind },
  }),
}));
vi.mock("@/lib/idempotency", () => ({ requestFingerprint: mocks.fingerprint }));
vi.mock("@/lib/pricing", () => ({ calculatePrice: mocks.calculatePrice }));
vi.mock("@/lib/vip", () => ({ checkVipStatus: mocks.vip }));
vi.mock("@/lib/care-booking-atomic", () => ({
  CareBookingIdempotencyConflict: class CareBookingIdempotencyConflict extends Error {},
  createCareBookingAtomically: mocks.createAtomic,
}));

import { POST } from "@/app/api/care/bookings/route";

const payload = {
  vehicleId: "vehicle-1",
  packageId: null,
  serviceType: "periodic",
  location: "Tehran",
  lat: null,
  lng: null,
  date: null,
  timeWindow: null,
  currentMileage: null,
};

function request() {
  return new Request("https://mekanix.test/api/care/bookings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": "care-test-key-0001",
    },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  mocks.auth.mockResolvedValue({ userId: "user-1", role: "CUSTOMER" });
  mocks.validateBody.mockResolvedValue({ ok: true, data: payload });
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.fingerprint.mockResolvedValue("fingerprint-1");
  mocks.vehicleFind.mockResolvedValue({ id: "vehicle-1", customerId: "customer-1", type: "EXCAVATOR" });
  mocks.bookingFind.mockResolvedValue(null);
  mocks.calculatePrice.mockResolvedValue({});
  mocks.vip.mockResolvedValue({ active: false, discountPercent: 0 });
  mocks.createAtomic.mockResolvedValue({ id: "booking-1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

describe("CARE fixed-labor production gate", () => {
  it("blocks new production bookings before the legacy hourly calculator runs", async () => {
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "FIXED_LABOR_RATE_CARD_NOT_IMPLEMENTED",
    });
    expect(mocks.calculatePrice).not.toHaveBeenCalled();
    expect(mocks.createAtomic).not.toHaveBeenCalled();
  });

  it("still replays an identical already-committed booking without recalculating price", async () => {
    mocks.bookingFind.mockResolvedValue({
      id: "booking-existing",
      requestFingerprint: "fingerprint-1",
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "booking-existing" });
    expect(mocks.calculatePrice).not.toHaveBeenCalled();
    expect(mocks.createAtomic).not.toHaveBeenCalled();
  });
});
