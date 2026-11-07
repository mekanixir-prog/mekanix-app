// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  customer: vi.fn(),
  vehicleFind: vi.fn(),
  requestFind: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({
  getCustomerFromSession: mocks.customer,
  getTechnicianFromSession: vi.fn(),
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    vehicle: { findUnique: mocks.vehicleFind },
    serviceRequest: { findUnique: mocks.requestFind },
    technician: { findMany: vi.fn() },
    user: { findFirst: vi.fn() },
    notification: { create: vi.fn() },
  }),
}));
vi.mock("@/lib/service-request-atomic", () => ({
  createServiceRequestAtomically: mocks.create,
}));

import { POST } from "@/app/api/service-requests/route";

const session = { userId: "user-1", role: "CUSTOMER" };
const customer = { id: "customer-1" };
const baseBody = {
  category: "engine",
  title: "Engine fault",
  address: "Tehran",
  lat: 35.7,
  lng: 51.4,
};

function makeRequest(body: unknown) {
  return new Request("https://mekanix.test/api/service-requests", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "request-key-0001" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(session);
  mocks.customer.mockResolvedValue(customer);
  mocks.vehicleFind.mockResolvedValue({
    customerId: customer.id,
    type: "EXCAVATOR",
    make: "Caterpillar",
    model: "320",
  });
  mocks.requestFind.mockResolvedValue({
    id: "request-1",
    code: "SR-1",
    customer: null,
    vehicle: null,
    matchedTech: null,
    job: null,
  });
  mocks.create.mockResolvedValue({ id: "request-1", created: false });
});

describe("service request vehicle gate", () => {
  it("requires a registered vehicle before creating a request", async () => {
    const response = await POST(makeRequest(baseBody));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VEHICLE_REGISTRATION_REQUIRED" });
    expect(mocks.vehicleFind).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a registered passenger vehicle outside the supported scope", async () => {
    mocks.vehicleFind.mockResolvedValueOnce({
      customerId: customer.id,
      type: "CAR",
      make: "ایران خودرو",
      model: "دنا",
    });
    const response = await POST(makeRequest({ ...baseBody, vehicleId: "vehicle-1" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VEHICLE_OUT_OF_SCOPE" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uses the registered vehicle data instead of client-supplied type or make", async () => {
    const response = await POST(makeRequest({
      ...baseBody,
      vehicleId: "vehicle-1",
      machineType: "CAR",
      make: "Saipa",
      model: "Quick",
    }));
    expect(response.status).toBe(200);
    expect(mocks.vehicleFind).toHaveBeenCalledWith({
      where: { id: "vehicle-1" },
      select: { customerId: true, type: true, make: true, model: true },
    });
    const createInput = mocks.create.mock.calls[0][1];
    expect(createInput).toMatchObject({ vehicleId: "vehicle-1" });
    expect(createInput).not.toHaveProperty("machineType");
    expect(createInput).not.toHaveProperty("make");
    expect(createInput).not.toHaveProperty("model");
  });
});
