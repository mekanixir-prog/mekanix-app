// MEKANIX — Assets module barrel.
//
// Re-exports the unified Asset abstraction (`src/lib/asset-types.ts`) plus the
// Iranian vehicle database (`src/lib/vehicle-db.ts`) and the vehicle Zod
// schemas (`src/lib/schemas/vehicle.ts`).
//
// Importing from here gives consumers a single canonical entry point for any
// code that needs to deal with vehicles / machinery / assets:
//
//   import { vehicleToAsset, getAssetType, vehicleCreateSchema } from "@/modules/assets";

// Unified Asset abstraction (ARCHITECTURE.md §7)
export {
  vehicleToAsset,
  getAssetType,
  isVehicle,
  isMachinery,
  type AssetType,
  type AssetBase,
  type VehicleAsset,
  type MachineryAsset,
  type Asset,
} from "@/lib/asset-types";

// Vehicle / machinery Zod schemas (input contracts for /api/vehicles)
export {
  vehicleCreateSchema,
  vehicleUpdateSchema,
  vehicleTypeEnum,
  VEHICLE_TYPES,
  type VehicleCreateInput,
  type VehicleUpdateInput,
} from "@/lib/schemas/vehicle";

// Vehicle DB (Iranian assemblers + foreign brands + per-model metadata)
export {
  PASSENGER_MAKES,
  HEAVY_MAKES,
  SEGMENT_LABELS,
  FUEL_LABELS,
  getMakesForMode,
  getIranianMakes,
  getModelMeta,
  findMake,
  type VehicleMake,
  type VehicleModel,
  type VehicleSegment,
  type VehicleFuel,
} from "@/lib/vehicle-db";

// Prisma-derived Vehicle domain type + helpers
export {
  type Vehicle,
} from "@/lib/api";

// Server-side BOLA helpers for vehicles (ownership check)
export {
  requireVehicleOwner,
} from "@/lib/auth";
