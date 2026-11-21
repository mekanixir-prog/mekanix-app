// MEKANIX — Zod Validation Schemas
import { z } from "zod";

export const otpSendSchema = z.object({
  phone: z.string().regex(/^\+?\d{8,15}$/, "شماره موبایل نامعتبر است"),
});

export const otpVerifySchema = z.object({
  phone: z.string().regex(/^\+?\d{8,15}$/, "شماره موبایل نامعتبر است"),
  code: z.string().regex(/^\d{4,6}$/, "کد باید ۴ تا ۶ رقم باشد"),
  name: z.string().max(100).optional(),
});

export const createVehicleSchema = z.object({
  type: z.enum(["CAR", "TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL", "OTHER"]),
  make: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
  plate: z.string().max(50).optional(),
  vin: z.string().max(50).optional(),
  engineHours: z.number().int().min(0).optional(),
  location: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  notes: z.string().max(1000).optional(),
});

export const createRequestSchema = z.object({
  vehicleId: z.string().min(1).optional(),
  category: z.string().min(1).max(50),
  urgency: z.enum(["NORMAL", "URGENT", "EMERGENCY"]).optional(),
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  mediaUrls: z.array(z.string().url()).max(12).optional(),
  address: z.string().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const updateJobStatusSchema = z.object({
  status: z.enum([
    "REQUESTED", "ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING",
    "REPAIRING", "WAITING_APPROVAL", "COMPLETED", "CANCELLED", "REJECTED"
  ]),
  customerApproved: z.boolean().optional(),
  technicianNotes: z.string().max(2000).optional(),
  laborHours: z.number().min(0).max(100).optional(),
  laborRate: z.number().min(0).max(1000).optional(),
  diagnosis: z.string().max(5000).optional(),
});

export const sendMessageSchema = z.object({
  jobId: z.string().min(1),
  body: z.string().min(1).max(5000),
  kind: z.enum(["text", "image", "system", "voice"]).optional(),
});

export const createReviewSchema = z.object({
  jobId: z.string().min(1),
  technicianId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
  tags: z.string().max(200).optional(),
});

export const payInvoiceSchema = z.object({
  invoiceId: z.string().min(1),
  method: z.enum(["card", "wallet", "bank", "cash"]),
});

export const withdrawSchema = z.object({
  amount: z.number().positive().max(10000),
  method: z.enum(["card", "bank"]),
  cardNumber: z.string().max(30).optional(),
  bankName: z.string().max(100).optional(),
  shebaNumber: z.string().max(30).optional(),
});

export const createTicketSchema = z.object({
  subject: z.string().min(3).max(200),
  category: z.enum(["billing", "jobs", "account", "technical", "other"]),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  message: z.string().min(1).max(5000),
});

export const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().max(200).optional(),
  nationalId: z.string().regex(/^\d{10}$/, "کد ملی باید ۱۰ رقم باشد").optional().or(z.literal("")),
  address: z.string().min(5).max(500).optional(),
  postalCode: z.string().regex(/^\d{10}$/, "کد پستی باید ۱۰ رقم باشد").optional().or(z.literal("")),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
}).refine((data) => Object.values(data).some((v) => v !== undefined && v !== ""), { message: "حداقل یک فیلد الزامی است" });

export const createPolicySchema = z.object({
  provider: z.string().min(1).max(100),
  policyNumber: z.string().min(1).max(100),
  type: z.enum(["third-party", "comprehensive", "zero"]),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  premiumAmount: z.number().positive(),
  coverageAmount: z.number().min(0).optional(),
  vehicleId: z.string().optional(),
  notes: z.string().max(1000).optional(),
});

export const fileClaimSchema = z.object({
  policyId: z.string().min(1),
  description: z.string().min(5).max(2000),
  amount: z.number().positive(),
});

export const createMaintenanceSchema = z.object({
  vehicleId: z.string().min(1),
  category: z.string().min(1),
  title: z.string().min(1).max(200),
  intervalKm: z.number().int().min(0).optional(),
  intervalHours: z.number().int().min(0).optional(),
  intervalDays: z.number().int().min(0).optional(),
  notes: z.string().max(1000).optional(),
  active: z.boolean().optional(),
});
