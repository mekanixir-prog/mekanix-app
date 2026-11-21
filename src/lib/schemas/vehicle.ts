import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";
// MEKANIX — Zod schemas for vehicle / machinery request bodies.
//
// Used by:
//   - src/app/api/vehicles/route.ts        (POST) → vehicleCreateSchema
//   - src/app/api/vehicles/[id]/route.ts   (PATCH) → vehicleUpdateSchema (partial)
//
// The Vehicle model (prisma/schema.prisma) supports both on-road vehicles
// (CAR / TRUCK / BUS) and heavy machinery (EXCAVATOR / LOADER / BULLDOZER /
// GRADER / AGRI / INDUSTRIAL). The schema enumerates the allowed `type`
// values so an unknown type fails fast with a 400 instead of producing a
// Prisma constraint error at insert time.

import { z } from "zod";

// Mirrors the `type` field on the Vehicle model in prisma/schema.prisma.
// IMPORTANT: keep in sync with the Prisma enum/string values.
export const VEHICLE_TYPES = [
  "CAR",
  "TRUCK",
  "BUS",
  "EXCAVATOR",
  "LOADER",
  "BULLDOZER",
  "GRADER",
  "AGRI",
  "INDUSTRIAL",
  "OTHER",
] as const;

export const vehicleTypeEnum = z.enum(VEHICLE_TYPES, {
  error: "نوع خودرو نامعتبر است",
});

// ──────────── Create ────────────
// POST /api/vehicles
export const vehicleCreateSchema = z.object({
  type: vehicleTypeEnum,
  make: z.string({ error: "برند الزامی است" }).min(1, "برند الزامی است").max(100, "برند بیش از حد طولانی است"),
  model: z.string({ error: "مدل الزامی است" }).min(1, "مدل الزامی است").max(100, "مدل بیش از حد طولانی است"),
  year: z
    .number({ error: "سال باید عدد باشد" })
    .int("سال باید عدد صحیح باشد")
    .min(1900, "سال نامعتبر است")
    .max(new Date().getFullYear() + 1, "سال نامعتبر است"),
  plate: z.string().max(50).optional(),
  vin: z.string().max(50).optional(),
  engineHours: z.number({ error: "ساعت کار باید عدد باشد" }).int("ساعت کار باید عدد صحیح باشد").min(0).optional(),
  location: z.string().max(200).optional(),
  lat: z.number({ error: "عرض جغرافیایی باید عدد باشد" }).min(-90, "عرض جغرافیایی نامعتبر است").max(90, "عرض جغرافیایی نامعتبر است").optional(),
  lng: z.number({ error: "طول جغرافیایی باید عدد باشد" }).min(-180, "طول جغرافیایی نامعتبر است").max(180, "طول جغرافیایی نامعتبر است").optional(),
  image: z.string().url("آدرس تصویر نامعتبر است").max(2048).optional(),
  notes: z.string().max(1000).optional(),
}).superRefine((data, ctx) => {
  if (data.type === "OTHER") {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: "نوع عمومی OTHER نرخ‌نامه تأییدشده ندارد؛ نوع دقیق ماشین‌آلات را انتخاب کنید",
    });
  } else if (!isVehicleInSupportedScope(data.type, data.make)) {
    ctx.addIssue({
      code: "custom",
      path: ["make"],
      message: "خودروهای ایران‌خودرو، سایپا و پارس‌خودرو در محدوده خدمات سواری MEKANIX نیستند",
    });
  }
});

export type VehicleCreateInput = z.infer<typeof vehicleCreateSchema>;

// ──────────── Update (partial) ────────────
// PATCH /api/vehicles/[id]
// All fields are optional; we additionally forbid type/year changes if needed
// in the future by omitting them here. For now, we allow all fields to be
// optionally updated.
export const vehicleUpdateSchema = z
  .object({
    type: vehicleTypeEnum.optional(),
    make: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    year: z
      .number()
      .int()
      .min(1900)
      .max(new Date().getFullYear() + 1)
      .optional(),
    plate: z.string().max(50).optional(),
    vin: z.string().max(50).optional(),
    engineHours: z.number().int().min(0).optional(),
    location: z.string().max(200).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    image: z.string().url().max(2048).optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "حداقل یک فیلد برای به‌روزرسانی الزامی است",
  })
  .superRefine((data, ctx) => {
    if (data.type === "OTHER") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "نوع عمومی OTHER نرخ‌نامه تأییدشده ندارد؛ نوع دقیق ماشین‌آلات را انتخاب کنید",
      });
    } else if (data.type === "CAR" && data.make && !isVehicleInSupportedScope(data.type, data.make)) {
      ctx.addIssue({
        code: "custom",
        path: ["make"],
        message: "خودروهای ایران‌خودرو، سایپا و پارس‌خودرو در محدوده خدمات سواری MEKANIX نیستند",
      });
    }
  });

export type VehicleUpdateInput = z.infer<typeof vehicleUpdateSchema>;
