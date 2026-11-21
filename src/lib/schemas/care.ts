// MEKANIX — Zod schemas for CARE booking flow request bodies.
//
// CARE = scheduled maintenance (distinct from on-demand service requests).
// Flow:
//   1. Customer books a CARE slot        → careBookingSchema
//   2. Technician inspects the vehicle   → inspectionSchema
//   3. Technician logs findings           → findingCreateSchema
//   4. Technician proposes an extra cost  → extraProposalSchema
//   5. Customer approves/rejects the extra → approveExtraSchema / (reject is same shape)
//   6. Technician files the health report → healthReportSchema
//
// These schemas are the input contracts for the routes under
//   src/app/api/care/bookings/*

import { z } from "zod";

// ──────────── 1. Booking ────────────
// POST /api/care/bookings
export const careBookingSchema = z.object({
  vehicleId: z.string({ error: "خودرو الزامی است" }).min(1, "خودرو الزامی است"),
  packageId: z.string().min(1).optional(),
  serviceType: z.enum(["periodic"]).default("periodic"),
  expectedPricingVersion: z.string({ error: "نسخه نرخ‌نامه الزامی است" }).min(1).max(64),
  location: z.string({ error: "محل الزامی است" }).min(1, "محل الزامی است").max(300, "محل بیش از حد طولانی است"),
  lat: z.number({ error: "عرض جغرافیایی باید عدد باشد" }).min(-90, "عرض جغرافیایی نامعتبر است").max(90, "عرض جغرافیایی نامعتبر است").optional(),
  lng: z.number({ error: "طول جغرافیایی باید عدد باشد" }).min(-180, "طول جغرافیایی نامعتبر است").max(180, "طول جغرافیایی نامعتبر است").optional(),
  date: z.string().optional(), // ISO date string — validated downstream by `new Date(date)`
  timeWindow: z.string().max(50).optional(),
  currentMileage: z.number({ error: "کیلومتر باید عدد باشد" }).int("کیلومتر باید عدد صحیح باشد").positive("کیلومتر باید مثبت باشد").optional(),
});

export type CareBookingInput = z.infer<typeof careBookingSchema>;

// ──────────── 2. Inspection ────────────
// POST /api/care/bookings/[id]/inspection
export const inspectionSchema = z.object({
  results: z.record(z.string(), z.unknown()).optional(),
  measurements: z.record(z.string(), z.unknown()).optional(),
  images: z.array(z.string().url().max(2048)).max(50).optional(),
  notes: z.string().max(5000).optional(),
});

export type InspectionInput = z.infer<typeof inspectionSchema>;

// ──────────── 3. Findings ────────────
// POST /api/care/bookings/[id]/findings
export const findingCreateSchema = z.object({
  category: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  recommendedAction: z.string().max(2000).optional(),
});

export type FindingCreateInput = z.infer<typeof findingCreateSchema>;

// ──────────── 4. Extra cost proposal (technician → customer) ────────────
// POST /api/care/bookings/[id]/extra-proposal
export const extraProposalSchema = z.object({
  // Either reference an existing finding, or inline a new finding payload:
  findingId: z.string().min(1).optional(),
  finding: z
    .object({
      category: z.string().min(1).max(100).optional(),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    })
    .optional(),
  // Proposed item / cost:
  proposedItem: z.string().min(1, "شرح پیشنهاد الزامی است").max(200),
  description: z.string().max(2000).optional(),
  partName: z.string().max(200).optional(),
  partBrand: z.string().max(100).optional(),
  partNumber: z.string().max(100).optional(),
  partType: z.enum(["OEM", "AFTERMARKET", "USED", "GENERIC"]).optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  partPrice: z.number().min(0).max(10_000_000).optional(),
  laborPrice: z.number().min(0).max(10_000_000).optional(),
  imageUrl: z.string().url().max(2048).optional(),
  technicianNote: z.string().max(2000).optional(),
});

export type ExtraProposalInput = z.infer<typeof extraProposalSchema>;

// ──────────── 5. Customer approve / reject ────────────
// POST /api/care/bookings/[id]/approve-extra
// POST /api/care/bookings/[id]/reject-extra
// Both routes accept just `{ approvalId }`.
export const approveExtraSchema = z.object({
  approvalId: z.string().min(1, "approvalId الزامی است"),
});

export type ApproveExtraInput = z.infer<typeof approveExtraSchema>;

// Alias for symmetry with the reject endpoint.
export const rejectExtraSchema = approveExtraSchema;
export type RejectExtraInput = z.infer<typeof rejectExtraSchema>;

// ──────────── 6. Health report ────────────
// POST /api/care/bookings/[id]/health-report
export const healthReportSchema = z.object({
  overallScore: z.number().int().min(0).max(100).optional(),
  engineScore: z.number().min(0).max(100).optional(),
  oilScore: z.number().min(0).max(100).optional(),
  brakeScore: z.number().min(0).max(100).optional(),
  batteryScore: z.number().min(0).max(100).optional(),
  tireScore: z.number().min(0).max(100).optional(),
  filterScore: z.number().min(0).max(100).optional(),
  fluidScore: z.number().min(0).max(100).optional(),
  coolingScore: z.number().min(0).max(100).optional(),
  beltScore: z.number().min(0).max(100).optional(),
  leakScore: z.number().min(0).max(100).optional(),
  diagnosticScore: z.number().min(0).max(100).optional(),
  categories: z.record(z.string(), z.unknown()).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

export type HealthReportInput = z.infer<typeof healthReportSchema>;
