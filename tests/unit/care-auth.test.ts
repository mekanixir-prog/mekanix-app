// MEKANIX Phase 6 — Unit tests for the CARE state machine (@/lib/care-auth)
//
// Covers:
//   - isValidTransition returns true for valid forward transitions
//   - isValidTransition returns false for invalid / backwards transitions
//   - isValidTransition respects the role gates (CUSTOMER vs TECHNICIAN)
//   - isValidApprovalTransition works for PROPOSED → APPROVED/REJECTED
//   - isValidApprovalTransition returns false for terminal states
//
// Note: the implementation uses ApprovalStatus = "PROPOSED" | "CUSTOMER_APPROVED"
// | "CUSTOMER_REJECTED" (not "APPROVED"/"REJECTED"). The tests reflect the
// actual implementation rather than the spec's shorthand.
import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  validateTransition,
  isValidApprovalTransition,
  APPROVAL_TRANSITIONS,
  type BookingStatus,
} from "@/lib/care-auth";

describe("care-auth — isValidTransition (valid forward workflow)", () => {
  it("REQUESTED → SCHEDULED is valid for ADMIN", () => {
    expect(isValidTransition("ADMIN", "REQUESTED", "SCHEDULED")).toBe(true);
  });

  it("SCHEDULED → MATCHING is valid for ADMIN", () => {
    expect(isValidTransition("ADMIN", "SCHEDULED", "MATCHING")).toBe(true);
  });

  it("MATCHING → ASSIGNED is valid for ADMIN", () => {
    expect(isValidTransition("ADMIN", "MATCHING", "ASSIGNED")).toBe(true);
  });

  it("ASSIGNED → EN_ROUTE is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "ASSIGNED", "EN_ROUTE")).toBe(true);
  });

  it("EN_ROUTE → ARRIVED is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "EN_ROUTE", "ARRIVED")).toBe(true);
  });

  it("ARRIVED → INSPECTING is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "ARRIVED", "INSPECTING")).toBe(true);
  });

  it("INSPECTING → WAITING_CUSTOMER_APPROVAL is valid for TECHNICIAN", () => {
    expect(
      isValidTransition("TECHNICIAN", "INSPECTING", "WAITING_CUSTOMER_APPROVAL")
    ).toBe(true);
  });

  it("INSPECTING → IN_SERVICE is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "INSPECTING", "IN_SERVICE")).toBe(true);
  });

  it("WAITING_CUSTOMER_APPROVAL → APPROVED is valid for CUSTOMER", () => {
    expect(
      isValidTransition("CUSTOMER", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBe(true);
  });

  it("WAITING_CUSTOMER_APPROVAL → APPROVED is valid for FLEET_MANAGER", () => {
    expect(
      isValidTransition("FLEET_MANAGER", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBe(true);
  });

  it("APPROVED → IN_SERVICE is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "APPROVED", "IN_SERVICE")).toBe(true);
  });

  it("IN_SERVICE → FINAL_CHECK is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "IN_SERVICE", "FINAL_CHECK")).toBe(true);
  });

  it("FINAL_CHECK → COMPLETED is valid for TECHNICIAN", () => {
    expect(isValidTransition("TECHNICIAN", "FINAL_CHECK", "COMPLETED")).toBe(true);
  });

  it("REQUESTED → CANCELLED is valid for CUSTOMER (pre-service cancel)", () => {
    expect(isValidTransition("CUSTOMER", "REQUESTED", "CANCELLED")).toBe(true);
  });

  it("ASSIGNED → CANCELLED is valid for CUSTOMER (pre-service cancel)", () => {
    expect(isValidTransition("CUSTOMER", "ASSIGNED", "CANCELLED")).toBe(true);
  });
});

describe("care-auth — isValidTransition (invalid transitions)", () => {
  it("COMPLETED is terminal — cannot transition to anything", () => {
    const next: BookingStatus[] = [
      "REQUESTED", "SCHEDULED", "MATCHING", "ASSIGNED", "EN_ROUTE",
      "ARRIVED", "INSPECTING", "WAITING_CUSTOMER_APPROVAL", "APPROVED",
      "IN_SERVICE", "FINAL_CHECK", "CANCELLED", "FAILED",
    ];
    for (const n of next) {
      expect(isValidTransition("ADMIN", "COMPLETED", n)).toBe(false);
    }
  });

  it("CANCELLED is terminal — cannot transition to anything", () => {
    expect(isValidTransition("ADMIN", "CANCELLED", "REQUESTED")).toBe(false);
    expect(isValidTransition("ADMIN", "CANCELLED", "COMPLETED")).toBe(false);
    expect(isValidTransition("ADMIN", "CANCELLED", "IN_SERVICE")).toBe(false);
  });

  it("FAILED is terminal — cannot transition to anything", () => {
    expect(isValidTransition("ADMIN", "FAILED", "REQUESTED")).toBe(false);
    expect(isValidTransition("ADMIN", "FAILED", "COMPLETED")).toBe(false);
  });

  it("REQUESTED → COMPLETED is invalid (skips the whole flow)", () => {
    expect(isValidTransition("ADMIN", "REQUESTED", "COMPLETED")).toBe(false);
  });

  it("REQUESTED → IN_SERVICE is invalid (skips inspection)", () => {
    expect(isValidTransition("ADMIN", "REQUESTED", "IN_SERVICE")).toBe(false);
  });

  it("Backwards transition INSPECTING → ARRIVED is invalid", () => {
    expect(isValidTransition("TECHNICIAN", "INSPECTING", "ARRIVED")).toBe(false);
  });

  it("Backwards transition IN_SERVICE → INSPECTING is invalid", () => {
    expect(isValidTransition("TECHNICIAN", "IN_SERVICE", "INSPECTING")).toBe(false);
  });

  it("Unknown current status returns false", () => {
    expect(isValidTransition("ADMIN", "BOGUS", "REQUESTED")).toBe(false);
  });

  it("Unknown next status returns false", () => {
    expect(isValidTransition("ADMIN", "REQUESTED", "BOGUS")).toBe(false);
  });
});

describe("care-auth — isValidTransition respects role", () => {
  it("CUSTOMER cannot drive the workflow forward", () => {
    // Customer is not allowed to set any technician-side next state
    expect(isValidTransition("CUSTOMER", "REQUESTED", "SCHEDULED")).toBe(false);
    expect(isValidTransition("CUSTOMER", "ASSIGNED", "EN_ROUTE")).toBe(false);
    expect(isValidTransition("CUSTOMER", "ARRIVED", "INSPECTING")).toBe(false);
    expect(isValidTransition("CUSTOMER", "INSPECTING", "IN_SERVICE")).toBe(false);
  });

  it("CUSTOMER cannot COMPLETED the booking", () => {
    expect(isValidTransition("CUSTOMER", "FINAL_CHECK", "COMPLETED")).toBe(false);
  });

  it("CUSTOMER cannot APPROVE unless WAITING_CUSTOMER_APPROVAL", () => {
    // Valid scenario: customer approves from the WAITING state
    expect(
      isValidTransition("CUSTOMER", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBe(true);
    // Invalid scenario: customer tries to approve from INSPECTING (no proposal)
    expect(isValidTransition("CUSTOMER", "INSPECTING", "APPROVED")).toBe(false);
    expect(isValidTransition("CUSTOMER", "REQUESTED", "APPROVED")).toBe(false);
  });

  it("CUSTOMER cannot CANCEL after IN_SERVICE (too late)", () => {
    expect(isValidTransition("CUSTOMER", "IN_SERVICE", "CANCELLED")).toBe(false);
    expect(isValidTransition("CUSTOMER", "FINAL_CHECK", "CANCELLED")).toBe(false);
    expect(isValidTransition("CUSTOMER", "COMPLETED", "CANCELLED")).toBe(false);
  });

  it("CUSTOMER can reject extra via WAITING_CUSTOMER_APPROVAL → INSPECTING", () => {
    expect(
      isValidTransition("CUSTOMER", "WAITING_CUSTOMER_APPROVAL", "INSPECTING")
    ).toBe(true);
  });

  it("CUSTOMER cannot move to INSPECTING from a non-WAITING state", () => {
    expect(isValidTransition("CUSTOMER", "REQUESTED", "INSPECTING")).toBe(false);
    expect(isValidTransition("CUSTOMER", "ARRIVED", "INSPECTING")).toBe(false);
  });

  it("TECHNICIAN can advance the workflow", () => {
    expect(isValidTransition("TECHNICIAN", "ASSIGNED", "EN_ROUTE")).toBe(true);
    expect(isValidTransition("TECHNICIAN", "EN_ROUTE", "ARRIVED")).toBe(true);
    expect(isValidTransition("TECHNICIAN", "ARRIVED", "INSPECTING")).toBe(true);
    expect(isValidTransition("TECHNICIAN", "FINAL_CHECK", "COMPLETED")).toBe(true);
  });

  it("TECHNICIAN cannot CANCEL (customer-only action)", () => {
    expect(isValidTransition("TECHNICIAN", "REQUESTED", "CANCELLED")).toBe(false);
    expect(isValidTransition("TECHNICIAN", "ASSIGNED", "CANCELLED")).toBe(false);
  });

  it("TECHNICIAN cannot APPROVE the customer-side approval", () => {
    expect(
      isValidTransition("TECHNICIAN", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBe(false);
  });

  it("PARTNER has no transitions (read-only analytics)", () => {
    expect(isValidTransition("PARTNER", "REQUESTED", "SCHEDULED")).toBe(false);
    expect(isValidTransition("PARTNER", "REQUESTED", "CANCELLED")).toBe(false);
    expect(isValidTransition("PARTNER", "FINAL_CHECK", "COMPLETED")).toBe(false);
  });

  it("FLEET_MANAGER mirrors CUSTOMER for the booking flow", () => {
    // Can cancel pre-service
    expect(isValidTransition("FLEET_MANAGER", "REQUESTED", "CANCELLED")).toBe(true);
    expect(isValidTransition("FLEET_MANAGER", "ASSIGNED", "CANCELLED")).toBe(true);
    // Can approve extras
    expect(
      isValidTransition("FLEET_MANAGER", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBe(true);
    // Cannot drive the workflow
    expect(isValidTransition("FLEET_MANAGER", "ASSIGNED", "EN_ROUTE")).toBe(false);
  });

  it("ADMIN can drive any forward transition", () => {
    expect(isValidTransition("ADMIN", "REQUESTED", "SCHEDULED")).toBe(true);
    expect(isValidTransition("ADMIN", "SCHEDULED", "MATCHING")).toBe(true);
    expect(isValidTransition("ADMIN", "MATCHING", "ASSIGNED")).toBe(true);
    expect(isValidTransition("ADMIN", "ASSIGNED", "EN_ROUTE")).toBe(true);
    expect(isValidTransition("ADMIN", "EN_ROUTE", "ARRIVED")).toBe(true);
    expect(isValidTransition("ADMIN", "ARRIVED", "INSPECTING")).toBe(true);
    expect(isValidTransition("ADMIN", "FINAL_CHECK", "COMPLETED")).toBe(true);
    expect(isValidTransition("ADMIN", "REQUESTED", "CANCELLED")).toBe(true);
  });
});

describe("care-auth — validateTransition()", () => {
  it("returns null when valid", () => {
    expect(validateTransition("TECHNICIAN", "ASSIGNED", "EN_ROUTE")).toBeNull();
    expect(
      validateTransition("CUSTOMER", "WAITING_CUSTOMER_APPROVAL", "APPROVED")
    ).toBeNull();
  });

  it("returns a 409 NextResponse when invalid", async () => {
    const err = validateTransition("TECHNICIAN", "REQUESTED", "COMPLETED");
    expect(err).not.toBeNull();
    expect(err!.status).toBe(409);
    const body = await err!.json();
    expect(body).toHaveProperty("error");
    expect(body.currentStatus).toBe("REQUESTED");
    expect(body.nextStatus).toBe("COMPLETED");
  });
});

describe("care-auth — isValidApprovalTransition()", () => {
  it("PROPOSED → CUSTOMER_APPROVED is valid", () => {
    expect(isValidApprovalTransition("PROPOSED", "CUSTOMER_APPROVED")).toBe(true);
  });

  it("PROPOSED → CUSTOMER_REJECTED is valid", () => {
    expect(isValidApprovalTransition("PROPOSED", "CUSTOMER_REJECTED")).toBe(true);
  });

  it("CUSTOMER_APPROVED is terminal — cannot transition", () => {
    expect(isValidApprovalTransition("CUSTOMER_APPROVED", "PROPOSED")).toBe(false);
    expect(isValidApprovalTransition("CUSTOMER_APPROVED", "CUSTOMER_REJECTED")).toBe(false);
  });

  it("CUSTOMER_REJECTED is terminal — cannot transition", () => {
    expect(isValidApprovalTransition("CUSTOMER_REJECTED", "PROPOSED")).toBe(false);
    expect(isValidApprovalTransition("CUSTOMER_REJECTED", "CUSTOMER_APPROVED")).toBe(false);
  });

  it("Unknown current status returns false", () => {
    expect(isValidApprovalTransition("BOGUS", "CUSTOMER_APPROVED")).toBe(false);
  });

  it("Unknown next status returns false", () => {
    expect(isValidApprovalTransition("PROPOSED", "BOGUS")).toBe(false);
  });

  it("APPROVAL_TRANSITIONS exposes the three canonical states", () => {
    expect(APPROVAL_TRANSITIONS.PROPOSED).toEqual([
      "CUSTOMER_APPROVED",
      "CUSTOMER_REJECTED",
    ]);
    expect(APPROVAL_TRANSITIONS.CUSTOMER_APPROVED).toEqual([]);
    expect(APPROVAL_TRANSITIONS.CUSTOMER_REJECTED).toEqual([]);
  });
});
