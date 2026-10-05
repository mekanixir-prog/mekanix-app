// @vitest-environment node
// MEKANIX — Unit tests for the Unified Service facade (src/lib/service-unified.ts)
//
// The facade exposes two pure converter functions (jobToService / bookingToService)
// that map each underlying Prisma model into a UnifiedService. These functions
// don't touch the DB — they only transform plain objects — so they're the right
// surface to unit-test the status-mapping + field-projection logic.
//
// The DB-backed queries (getServicesForUser / getServiceById / getServiceStats)
// are exercised indirectly via the integration tests for /api/jobs and
// /api/care/bookings.

import { describe, it, expect } from "vitest";
import {
  jobToService,
  bookingToService,
  type ServiceStatus,
} from "@/lib/service-unified";

// ─────────────────────────── jobToService ───────────────────────────

describe("service-unified — jobToService", () => {
  const baseJob = {
    id: "job_1",
    code: "JOB-2041",
    technicianId: "tech_1",
    status: "REPAIRING",
    createdAt: new Date("2024-01-01T10:00:00Z"),
    updatedAt: new Date("2024-01-01T11:00:00Z"),
    request: {
      customerId: "cust_1",
      customer: { userId: "user_1" },
      vehicleId: "veh_1",
      category: "engine",
      urgency: "URGENT",
      title: "Engine won't start",
      description: "Clicks but no crank",
      address: "Tehran, Valiasr",
      lat: 35.7,
      lng: 51.4,
    },
    technician: { user: { name: "Reza" } },
    invoice: { total: 100 },
    diagnosisRecords: [{ id: "diag_1", summary: "Dead battery" }],
  };

  it("maps source = 'job'", () => {
    expect(jobToService(baseJob).source).toBe("job");
  });

  it("resolves customerId via request.customer.userId (not request.customerId)", () => {
    expect(jobToService(baseJob).customerId).toBe("user_1");
  });

  it("maps REPAIRING → IN_SERVICE", () => {
    expect(jobToService(baseJob).status).toBe<ServiceStatus>("IN_SERVICE");
  });

  it("maps WAITING_APPROVAL → WAITING_CUSTOMER_APPROVAL", () => {
    expect(
      jobToService({ ...baseJob, status: "WAITING_APPROVAL" }).status
    ).toBe<ServiceStatus>("WAITING_CUSTOMER_APPROVAL");
  });

  it("maps ACCEPTED → ASSIGNED (the on-demand flow has no MATCHING state)", () => {
    expect(jobToService({ ...baseJob, status: "ACCEPTED" }).status).toBe<
      ServiceStatus
    >("ASSIGNED");
  });

  it("maps DIAGNOSING → INSPECTING", () => {
    expect(jobToService({ ...baseJob, status: "DIAGNOSING" }).status).toBe<
      ServiceStatus
    >("INSPECTING");
  });

  it("preserves terminal statuses (COMPLETED / CANCELLED / REJECTED)", () => {
    expect(jobToService({ ...baseJob, status: "COMPLETED" }).status).toBe<
      ServiceStatus
    >("COMPLETED");
    expect(jobToService({ ...baseJob, status: "CANCELLED" }).status).toBe<
      ServiceStatus
    >("CANCELLED");
    expect(jobToService({ ...baseJob, status: "REJECTED" }).status).toBe<
      ServiceStatus
    >("REJECTED");
  });

  it("falls back to REQUESTED for unknown status", () => {
    const jobWithUnknownStatus = { ...baseJob, status: "UNKNOWN" } as any;
    expect(jobToService(jobWithUnknownStatus).status).toBe<
      ServiceStatus
    >("REQUESTED");
  });

  it("attaches first diagnosis record as `inspection`", () => {
    expect(jobToService(baseJob).inspection).toEqual({
      id: "diag_1",
      summary: "Dead battery",
    });
  });

  it("attaches invoice", () => {
    expect(jobToService(baseJob).invoice).toEqual({ total: 100 });
  });

  it("does not attach booking-only fields (findings / approvals / timeline / healthReport)", () => {
    const s = jobToService(baseJob);
    expect(s.findings).toBeUndefined();
    expect(s.approvals).toBeUndefined();
    expect(s.timeline).toBeUndefined();
    expect(s.healthReport).toBeUndefined();
  });

  it("tolerates a Job without a request (no crash, empty strings)", () => {
    const minimal = {
      id: "job_x",
      code: "JOB-X",
      technicianId: "tech_x",
      status: "REQUESTED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const s = jobToService(minimal);
    expect(s.customerId).toBe("");
    expect(s.vehicleId).toBe("");
    expect(s.title).toBe("");
    expect(s.location).toBe("");
    expect(s.lat).toBeNull();
    expect(s.lng).toBeNull();
  });
});

// ─────────────────────────── bookingToService ───────────────────────────

describe("service-unified — bookingToService", () => {
  const baseBooking = {
    id: "bk_1",
    code: "CARE-123456",
    userId: "user_1",
    vehicleId: "veh_1",
    serviceType: "periodic",
    location: "Tehran, Jordan",
    lat: 35.8,
    lng: 51.45,
    status: "INSPECTING",
    technicianId: "tech_1",
    notes: "Customer reports squeak on cold start",
    createdAt: new Date("2024-02-01T08:00:00Z"),
    updatedAt: new Date("2024-02-01T08:30:00Z"),
    package: { name: "Full Service" },
    inspection: { id: "insp_1", results: "{}" },
    findings: [{ id: "f_1", severity: "MEDIUM" }],
    approvals: [{ id: "ap_1", status: "PROPOSED" }],
    timeline: [{ id: "t_1", eventType: "booking_created" }],
    healthReport: { id: "h_1", overallScore: 85 },
    pricing: { total: 500 },
  };

  it("maps source = 'booking'", () => {
    expect(bookingToService(baseBooking).source).toBe("booking");
  });

  it("uses booking.userId directly as customerId (no Customer join)", () => {
    expect(bookingToService(baseBooking).customerId).toBe("user_1");
  });

  it("maps INSPECTING → INSPECTING (identity)", () => {
    expect(bookingToService(baseBooking).status).toBe<ServiceStatus>(
      "INSPECTING"
    );
  });

  it("maps WAITING_CUSTOMER_APPROVAL → WAITING_CUSTOMER_APPROVAL (identity)", () => {
    expect(
      bookingToService({ ...baseBooking, status: "WAITING_CUSTOMER_APPROVAL" })
        .status
    ).toBe<ServiceStatus>("WAITING_CUSTOMER_APPROVAL");
  });

  it("preserves FINAL_CHECK (booking-only — Job has no equivalent)", () => {
    expect(bookingToService({ ...baseBooking, status: "FINAL_CHECK" }).status)
      .toBe<ServiceStatus>("FINAL_CHECK");
  });

  it("preserves APPROVED (booking-only — Job uses customerApproved Boolean)", () => {
    expect(bookingToService({ ...baseBooking, status: "APPROVED" }).status).toBe<
      ServiceStatus
    >("APPROVED");
  });

  it("preserves FAILED (booking-only — Job uses REJECTED)", () => {
    expect(bookingToService({ ...baseBooking, status: "FAILED" }).status).toBe<
      ServiceStatus
    >("FAILED");
  });

  it("falls back to REQUESTED for unknown status", () => {
    const bookingWithUnknownStatus = { ...baseBooking, status: "WAT" } as any;
    expect(bookingToService(bookingWithUnknownStatus).status).toBe<
      ServiceStatus
    >("REQUESTED");
  });

  it("title falls back to 'CARE Service' when no package", () => {
    expect(bookingToService({ ...baseBooking, package: null }).title).toBe(
      "CARE Service"
    );
  });

  it("title uses package.name when present", () => {
    expect(bookingToService(baseBooking).title).toBe("Full Service");
  });

  it("attaches all CARE-only relations (inspection / findings / approvals / timeline / healthReport / pricing)", () => {
    const s = bookingToService(baseBooking);
    expect(s.inspection).toEqual({ id: "insp_1", results: "{}" });
    expect(s.findings).toEqual([{ id: "f_1", severity: "MEDIUM" }]);
    expect(s.approvals).toEqual([{ id: "ap_1", status: "PROPOSED" }]);
    expect(s.timeline).toEqual([{ id: "t_1", eventType: "booking_created" }]);
    expect(s.healthReport).toEqual({ id: "h_1", overallScore: 85 });
    expect(s.pricing).toEqual({ total: 500 });
  });

  it("urgency defaults to 'NORMAL' (bookings don't carry urgency)", () => {
    expect(bookingToService(baseBooking).urgency).toBe("NORMAL");
  });

  it("tolerates a Booking with null lat/lng + missing package", () => {
    const minimal = {
      id: "bk_x",
      code: "CARE-X",
      userId: "user_x",
      vehicleId: "veh_x",
      location: null,
      lat: null,
      lng: null,
      status: "REQUESTED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const s = bookingToService(minimal);
    expect(s.lat).toBeNull();
    expect(s.lng).toBeNull();
    expect(s.location).toBe("");
    expect(s.title).toBe("CARE Service");
    expect(s.category).toBe("periodic"); // default serviceType
  });
});

// ─────────────────────────── status vocabulary ───────────────────────────

describe("service-unified — status vocabulary", () => {
  // Sanity: the unified ServiceStatus type is a superset of both models'
  // statuses — i.e. every JobStatus + every ServiceBooking.status has a
  // corresponding entry in ServiceStatus.
  it("includes statuses only present in Job (REJECTED)", () => {
    const jobOnly: ServiceStatus = "REJECTED";
    expect(jobOnly).toBe("REJECTED");
  });

  it("includes statuses only present in ServiceBooking (APPROVED / MATCHING / SCHEDULED / FINAL_CHECK / FAILED)", () => {
    const bookingOnly: ServiceStatus[] = [
      "APPROVED",
      "MATCHING",
      "SCHEDULED",
      "FINAL_CHECK",
      "FAILED",
    ];
    expect(bookingOnly).toHaveLength(5);
  });

  it("includes shared statuses (REQUESTED / ASSIGNED / EN_ROUTE / ARRIVED / INSPECTING / WAITING_CUSTOMER_APPROVAL / IN_SERVICE / COMPLETED / CANCELLED)", () => {
    const shared: ServiceStatus[] = [
      "REQUESTED",
      "ASSIGNED",
      "EN_ROUTE",
      "ARRIVED",
      "INSPECTING",
      "WAITING_CUSTOMER_APPROVAL",
      "IN_SERVICE",
      "COMPLETED",
      "CANCELLED",
    ];
    expect(shared).toHaveLength(9);
  });
});
