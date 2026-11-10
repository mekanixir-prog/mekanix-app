// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  customer: vi.fn(),
  technician: vi.fn(),
  jobFindUnique: vi.fn(),
}));

vi.mock("@/lib/db-access", () => ({ getDbForLib: mocks.db }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    getCustomerFromSession: mocks.customer,
    getTechnicianFromSession: mocks.technician,
  };
});

import { requireJobParticipant } from "@/lib/auth";

const session = (role: "CUSTOMER" | "TECHNICIAN" | "ADMIN" | "FLEET_MANAGER" | "PARTNER") => ({
  userId: "user-1",
  role,
  phone: null,
  isGuest: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.customer.mockResolvedValue({ id: "customer-1" });
  mocks.technician.mockResolvedValue({ id: "technician-1" });
  mocks.jobFindUnique.mockResolvedValue({
    id: "job-1",
    request: { customerId: "customer-1" },
    technicianId: "technician-1",
  });
  mocks.db.mockResolvedValue({ job: { findUnique: mocks.jobFindUnique } });
});

describe("requireJobParticipant role boundaries", () => {
  it.each(["FLEET_MANAGER", "PARTNER"] as const)(
    "fails closed for %s until an explicit fleet/partner scope exists",
    async (role) => {
      const response = await requireJobParticipant(session(role), "job-1");

      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({
        error: "دسترسی به این کار مجاز نیست",
      });
      expect(mocks.db).not.toHaveBeenCalled();
      expect(mocks.jobFindUnique).not.toHaveBeenCalled();
    },
  );

  it("allows the customer only when the job belongs to the customer profile", async () => {
    const response = await requireJobParticipant(session("CUSTOMER"), "job-1");

    expect(response).toBeNull();
    expect(mocks.jobFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1" },
    }));
  });

  it("allows the assigned technician only", async () => {
    const response = await requireJobParticipant(session("TECHNICIAN"), "job-1");

    expect(response).toBeNull();
  });

  it("allows ADMIN without an object lookup", async () => {
    const response = await requireJobParticipant(session("ADMIN"), "job-1");

    expect(response).toBeNull();
    expect(mocks.db).not.toHaveBeenCalled();
  });
});
