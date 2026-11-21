// MEKANIX — Dispatch module barrel.
//
// Dispatch covers the matching engine that pairs a ServiceRequest (or CARE
// booking) with a Technician, ranked by a weighted score per
// ARCHITECTURE.md §10:
//
//   score = (distance * 0.4) + (skill * 0.3) + (rating * 0.2) + (speed * 0.1)
//
// All inputs are normalized to 0..1 before weighting. The engine is
// distance-bounded (50 km radius) and pre-filtered to online + available
// technicians.

export {
  findBestTechnicians,
  autoAssignTechnician,
  type DispatchInput,
  type DispatchCandidate,
} from "@/lib/dispatch";

// Re-export the legacy types so existing callers that imported them from
// the Phase 3 stub continue to resolve.
export {
  type ServiceRequest,
  type Technician,
} from "@/lib/api";

export {
  requireRole,
  type Session,
} from "@/lib/auth";

export {
  PERMISSIONS,
  can,
} from "@/lib/permissions";
