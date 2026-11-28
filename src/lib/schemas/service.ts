// MEKANIX — Zod schemas for service request bodies.
//
// Used by:
//   - src/app/api/service-requests/route.ts (POST) → serviceRequestCreateSchema
//
// Service requests are the on-demand repair flow (distinct from CARE bookings
// which are scheduled maintenance). A customer files a request describing the
// problem + location; the dispatch engine then matches it to a technician.

import { z } from "zod";

// Urgency mirrors the ServiceRequest.urgency field in prisma/schema.prisma.
export const URGENCY_LEVELS = ["NORMAL", "URGENT", "EMERGENCY"] as const;

// ──────────── Create ────────────
// POST /api/service-requests
export const serviceRequestCreateSchema = z.object({
  // A service request is accepted only for a previously registered vehicle.
  vehicleId: z.string().min(1, "ثبت و انتخاب وسیله الزامی است"),

  category: z.string().min(1, "دسته‌بندی الزامی است").max(50, "دسته‌بندی بیش از حد طولانی است"),
  title: z
    .string()
    .min(3, "عنوان باید حداقل ۳ نویسه باشد")
    .max(200, "عنوان بیش از حد طولانی است"),
  description: z.string().max(2000).optional(),
  urgency: z.enum(URGENCY_LEVELS).optional(),
  mediaUrls: z.array(z.string().url()).max(12).optional(),
  voiceNote: z.string().max(500).optional(),
  address: z
    .string()
    .min(1, "آدرس الزامی است")
    .max(300, "آدرس بیش از حد طولانی است"),
  lat: z.number({ message: "عرض جغرافیایی الزامی است" }).min(-90).max(90),
  lng: z.number({ message: "طول جغرافیایی الزامی است" }).min(-180).max(180),
});

export type ServiceRequestCreateInput = z.infer<typeof serviceRequestCreateSchema>;

// ──────────── Status update (technician) ────────────
// PATCH /api/jobs/[id]/status
export const jobStatusUpdateSchema = z.object({
  status: z.enum([
    "REQUESTED",
    "ACCEPTED",
    "EN_ROUTE",
    "ARRIVED",
    "DIAGNOSING",
    "REPAIRING",
    "WAITING_APPROVAL",
    "COMPLETED",
    "CANCELLED",
    "REJECTED",
  ]),
  customerApproved: z.boolean().optional(),
  technicianNotes: z.string().max(2000).optional(),
  laborHours: z.number().min(0).max(100).optional(),
  laborRate: z.number().min(0).max(1000).optional(),
  diagnosis: z.string().max(5000).optional(),
});

export type JobStatusUpdateInput = z.infer<typeof jobStatusUpdateSchema>;

// ──────────── Job diagnosis ────────────
// POST /api/jobs/[id]/diagnosis
export const jobDiagnosisSchema = z.object({
  summary: z.string().min(1).max(2000),
  cause: z.string().max(2000).optional(),
  recommendation: z.string().max(2000).optional(),
  laborHours: z.number().min(0).max(100).optional(),
  laborRate: z.number().min(0).max(1000).optional(),
  mediaUrls: z.array(z.string().url()).max(12).optional(),
});

export type JobDiagnosisInput = z.infer<typeof jobDiagnosisSchema>;
