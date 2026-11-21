// MEKANIX — Zod schemas barrel.
//
// Central re-export of all MEKANIX API request-body schemas. Import from here:
//
//   import { otpSendSchema, vehicleCreateSchema } from "@/lib/schemas";
//
// Each domain lives in its own file under `src/lib/schemas/` for clarity.
// Keep this barrel alphabetized by domain so diffs stay readable.

export * from "./auth";
export * from "./vehicle";
export * from "./service";
export * from "./care";
export * from "./wallet";
