// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  assigned: vi.fn(),
  validTransition: vi.fn(),
  bookingFind: vi.fn(),
  notificationCreate: vi.fn(),
  createProposal: vi.fn(),
  technicianFromSession: vi.fn(),
}));

vi.mock("@/lib/api-helpers", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/auth", () => ({ getTechnicianFromSession: mocks.technicianFromSession }));
vi.mock("@/lib/care-auth", () => ({
  requireAssignedTechnician: mocks.assigned,
  isValidTransition: mocks.validTransition,
}));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({
    serviceBooking: { findUnique: mocks.bookingFind },
    notification: { create: mocks.notificationCreate },
  }),
}));
vi.mock("@/lib/care-extra-proposal-atomic", () => ({
  CareExtraProposalConflictError: class CareExtraProposalConflictError extends Error {},
  createCareExtraProposalAtomically: mocks.createProposal,
}));

import { POST } from "@/app/api/care/bookings/[id]/extra-proposal/route";

const approval = {
  id: "approval-1",
  status: "PROPOSED",
  financialUnitStatus: "VERIFIED_IRR",
  partPrice: 1_200_000,
  laborPrice: 800_000,
  totalPrice: 3_200_000,
};

function makeRequest(body: string) {
  return new Request("https://mekanix.test/api/care/bookings/booking-1/extra-proposal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const validBody = {
  proposedItem: "Hydraulic hose replacement",
  partPrice: 120_000,
  quantity: 2,
  laborPrice: 80_000,
  description: "Replace damaged hose",
  partName: "Hydraulic hose",
  partBrand: "OEM",
  partNumber: "H-100",
  partType: "OEM",
  technicianNote: "Leak confirmed",
  finding: {
    category: "hydraulic",
    title: "Hydraulic hose leak",
    description: "Leak near connector",
    severity: "HIGH",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: "technician-user", role: "TECHNICIAN" });
  mocks.technicianFromSession.mockResolvedValue({ id: "technician-profile-1" });
  mocks.assigned.mockResolvedValue(null);
  mocks.validTransition.mockReturnValue(true);
  mocks.bookingFind.mockResolvedValue({
    id: "booking-1",
    status: "INSPECTING",
    userId: "customer-user",
  });
  mocks.createProposal.mockResolvedValue(approval);
  mocks.notificationCreate.mockResolvedValue({});
});

describe("CARE extra proposal route", () => {
  it("validates optional fields and delegates all durable writes to the atomic helper", async () => {
    const response = await POST(makeRequest(JSON.stringify(validBody)), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(approval);
    expect(mocks.createProposal).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      bookingId: "booking-1",
      expectedBookingStatus: "INSPECTING",
      actorRole: "TECHNICIAN",
      actorUserId: "technician-user",
      actorTechnicianId: "technician-profile-1",
      proposal: expect.objectContaining({
        proposedItem: validBody.proposedItem,
        partPrice: 1_200_000,
        quantity: 2,
        laborPrice: 800_000,
        findingId: null,
      }),
      details: {
        description: validBody.description,
        partName: validBody.partName,
        partBrand: validBody.partBrand,
        partNumber: validBody.partNumber,
        partType: "OEM",
        imageUrl: null,
        technicianNote: validBody.technicianNote,
      },
      newFinding: validBody.finding,
    }));
    expect(mocks.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "customer-user",
        body: expect.stringContaining("پیشنهاد هزینه ثبت شد و پس از تأیید واحد مالی قابل بررسی است"),
      }),
    });
  });

  it("rejects a technician session without a trusted technician profile before writing", async () => {
    mocks.technicianFromSession.mockResolvedValue(null);
    const response = await POST(makeRequest(JSON.stringify(validBody)), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.createProposal).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before attempting database writes", async () => {
    const response = await POST(makeRequest("{"), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingFind).not.toHaveBeenCalled();
    expect(mocks.createProposal).not.toHaveBeenCalled();
  });

  it("rejects an unsupported part type", async () => {
    const response = await POST(makeRequest(JSON.stringify({ ...validBody, partType: "CUSTOM" })), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.createProposal).not.toHaveBeenCalled();
  });

  it("rejects ambiguous simultaneous existing and new finding inputs", async () => {
    const response = await POST(makeRequest(JSON.stringify({
      ...validBody,
      findingId: "finding-existing",
    })), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.createProposal).not.toHaveBeenCalled();
  });

  it("does not turn a committed proposal into an API failure when notification delivery fails", async () => {
    mocks.notificationCreate.mockRejectedValue(new Error("notification provider unavailable"));
    const response = await POST(makeRequest(JSON.stringify(validBody)), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(approval);
  });
});
