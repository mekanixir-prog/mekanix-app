// MEKANIX — Unified Asset abstraction (ARCHITECTURE.md §7)
//
// The Vehicle table currently stores both passenger vehicles (cars, trucks,
// buses) and heavy machinery (excavators, loaders, tractors, graders) in a
// single Prisma model — distinguished only by the `type` field on Vehicle
// (which is the MachineType enum: CAR / TRUCK / BUS / EXCAVATOR / LOADER /
// TRACTOR / GRADER / etc.).
//
// This module introduces a *read-side* Asset abstraction so that downstream
// code (UI, API routes, services) can treat vehicles and machinery
// uniformly without touching the underlying Vehicle model. We do NOT migrate
// the existing Vehicle model — that's high-risk and out of scope for
// Phase 3. Instead, this file provides:
//
//   1. Type definitions: AssetType, AssetBase, VehicleAsset, MachineryAsset
//      and the discriminated union `Asset`.
//   2. Conversion helpers (`vehicleToAsset`, `getAssetType`) that bridge the
//      existing Vehicle DB record into the unified Asset shape, returning
//      the correct asset kind based on Vehicle.type (MachineType enum).
//
// Usage:
//   import { vehicleToAsset, isMachinery, getAssetType } from "@/lib/asset-types";
//   const asset = vehicleToAsset(vehicleRecord);
//   if (asset.type === "machinery") { ... }
//
// Notes:
//   - `vehicleToAsset` accepts `any` so it works against any
//     Vehicle-shaped record (Prisma payload, mock, or partial). The output
//     is a fully-typed VehicleAsset OR MachineryAsset based on the `type`
//     field (MachineType enum value).
//   - `getAssetType` takes the Vehicle.type string (i.e. the MachineType
//     enum value) and returns `"vehicle"` for CAR and `"machinery"` for
//     everything else (TRUCK / BUS / EXCAVATOR / LOADER / TRACTOR / GRADER
//     / BULLDOZER / AGRI / INDUSTRIAL / OTHER). This matches the audit
//     finding that MEKANIX serves both passenger cars (CAR) and heavy
//     machinery (everything else).
//   - For vehicles (CAR), the existing `engineHours` field is reused as
//     the mileage (since the schema has no separate `mileage` column).
//   - For machinery, the existing `engineHours` field maps to `workingHours`
//     (heavy equipment is maintained by working/engine hours rather than
//     mileage) and the `vin` field is reused as `serialNumber`.

// ──────────── Asset type discriminator ────────────

export type AssetType = "vehicle" | "machinery";

// ──────────── Asset base shape ────────────
// Common fields shared by every asset kind. Mirrors the existing Vehicle
// columns (customerId → ownerId, make → brand, etc.) so the conversion is a
// 1:1 mapping with no data loss.

export interface AssetBase {
  id: string;
  ownerId: string;
  type: AssetType;
  brand: string;
  model: string;
  year?: number;
  location?: string;
  createdAt: Date;
}

// Vehicle extends AssetBase — passenger vehicles (CAR).
export interface VehicleAsset extends AssetBase {
  type: "vehicle";
  vin?: string;
  plate?: string;
  mileage?: number;
  fuel?: string;
}

// Machinery extends AssetBase — heavy equipment (EXCAVATOR / LOADER /
// TRACTOR / GRADER / TRUCK / BUS / BULLDOZER / AGRI / INDUSTRIAL / OTHER).
// The maintenance-cycle fields are machinery-specific because heavy
// equipment is maintained by working hours / engine hours rather than
// mileage.
export interface MachineryAsset extends AssetBase {
  type: "machinery";
  serialNumber?: string;
  workingHours?: number;
  engineHours?: number;
  maintenanceCycle?: number;
}

// Discriminated union of all asset kinds.
export type Asset = VehicleAsset | MachineryAsset;

// ──────────── Conversion helpers ────────────

/**
 * Convert a Vehicle DB record (or any Vehicle-shaped object) into an Asset
 * — either a VehicleAsset (when Vehicle.type === "CAR") or a
 * MachineryAsset (for every other MachineType value).
 *
 * The mapping is:
 *   - customerId → ownerId
 *   - make       → brand
 *
 * For vehicles (CAR):
 *   - engineHours → mileage  (the existing schema reuses `engineHours` for
 *                             passenger-car mileage since there's no
 *                             separate `mileage` column)
 *   - vin / plate → vin / plate (1:1)
 *
 * For machinery (everything else):
 *   - engineHours → workingHours (heavy equipment is maintained by
 *                                 working/engine hours rather than mileage)
 *   - vin         → serialNumber  (VIN field reused for machinery serial)
 *
 * Accepts `any` so callers can pass Prisma payloads, mocks, or partials
 * without first having to satisfy the full Vehicle type.
 */
export function vehicleToAsset(v: any): Asset {
  const assetType = getAssetType(v?.type);
  const base = {
    id: v.id,
    ownerId: v.customerId,
    brand: v.make,
    model: v.model,
    year: v.year,
    location: v.location,
    createdAt: v.createdAt,
  };

  if (assetType === "vehicle") {
    return {
      ...base,
      type: "vehicle" as const,
      vin: v.vin ?? undefined,
      plate: v.plate ?? undefined,
      // engineHours maps to mileage for vehicles (CAR)
      mileage: v.engineHours ?? undefined,
    };
  }

  return {
    ...base,
    type: "machinery" as const,
    // engineHours maps to workingHours for machinery
    workingHours: v.engineHours ?? undefined,
    // VIN field reused for machinery serial number
    serialNumber: v.vin ?? undefined,
  };
}

/**
 * Helper: get asset type from a Vehicle.type (MachineType enum) string.
 *
 * CAR is treated as a passenger vehicle; everything else (TRUCK / BUS /
 * EXCAVATOR / LOADER / BULLDOZER / GRADER / AGRI / INDUSTRIAL / OTHER) is
 * treated as machinery.
 */
export function getAssetType(machineType: string): AssetType {
  // CAR is the only "vehicle" type; everything else is "machinery"
  return machineType === "CAR" ? "vehicle" : "machinery";
}

// ──────────── Convenience type-guards ────────────

export function isVehicle(asset: Asset): asset is VehicleAsset {
  return asset.type === "vehicle";
}

export function isMachinery(asset: Asset): asset is MachineryAsset {
  return asset.type === "machinery";
}
