// MEKANIX — Permission Guard (ARCHITECTURE.md §17 Security Architecture)
//
// Implements a Role → Permission matrix. Permissions are dot-notation strings
// (e.g. "customer.create.service", "technician.accept.mission") so they read
// as `<role>.<action>.<subject>` and are easy to audit, log, and grep.
//
// Usage:
//   import { can, requirePermission, PERMISSIONS } from "@/lib/permissions";
//   if (!can(session.role, PERMISSIONS.CUSTOMER_CREATE_SERVICE)) return forbidden();
//   const guard = requirePermission(session.role, PERMISSIONS.CUSTOMER_PAY);
//   if (guard) return guard; // 403 NextResponse
//
// Notes:
//   - ADMIN bypasses everything (returns `true` for any permission).
//   - Unknown roles get no permissions (deny-by-default).
//   - This module is intentionally side-effect-free and pure, so it can be
//     called from API routes, server components, and middleware alike.
//   - Existing routes that already use `requireRole` (role-level guard) do NOT
//     need to change; `requirePermission` is a finer-grained option for routes
//     that need to distinguish actions within a single role.

import { NextResponse } from "next/server";
import type { Session } from "./auth";

// ──────────── Permissions ────────────
// Dot-notation: `<role>.<action>.<subject>`.
// Keeping them as `as const` lets us derive a union type for type-safe calls.

export type Permission = string;

export const PERMISSIONS = {
  // Customer permissions
  CUSTOMER_CREATE_SERVICE: "customer.create.service",
  CUSTOMER_MANAGE_VEHICLES: "customer.manage.vehicles",
  CUSTOMER_BOOK_CARE: "customer.book.care",
  CUSTOMER_APPROVE_EXTRA: "customer.approve.extra",
  CUSTOMER_PAY: "customer.pay",
  CUSTOMER_REVIEW: "customer.review",

  // Technician permissions
  TECHNICIAN_ACCEPT_MISSION: "technician.accept.mission",
  TECHNICIAN_UPDATE_STATUS: "technician.update.status",
  TECHNICIAN_INSPECT: "technician.inspect",
  TECHNICIAN_PROPOSE_EXTRA: "technician.propose.extra",
  TECHNICIAN_HEALTH_REPORT: "technician.health.report",
  TECHNICIAN_WITHDRAW: "technician.withdraw",

  // Fleet manager permissions
  FLEET_VIEW_DASHBOARD: "fleet.view.dashboard",
  FLEET_MANAGE_ASSETS: "fleet.manage.assets",

  // Partner permissions
  PARTNER_VIEW_ANALYTICS: "partner.view.analytics",

  // Admin permissions (all)
  ADMIN_ALL: "admin.all",
} as const;

// Compile-time union of all known permission strings (handy for type-safe callers).
export type KnownPermission =
  | (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// ──────────── Role → Permission matrix ────────────
//
// Roles mirror the Role enum in prisma/schema.prisma (CUSTOMER / TECHNICIAN /
// ADMIN) plus the two future roles from ARCHITECTURE.md §5 (FLEET_MANAGER,
// PARTNER) which are not yet DB-backed but should map cleanly when added.
//
// Design rules:
//   - Deny by default: a role not present in the map has zero permissions.
//   - ADMIN is also short-circuited in `can()` so adding new permissions
//     automatically grants them to admin without touching the map.

const ROLE_PERMISSIONS: Record<string, Set<Permission>> = {
  CUSTOMER: new Set<Permission>([
    PERMISSIONS.CUSTOMER_CREATE_SERVICE,
    PERMISSIONS.CUSTOMER_MANAGE_VEHICLES,
    PERMISSIONS.CUSTOMER_BOOK_CARE,
    PERMISSIONS.CUSTOMER_APPROVE_EXTRA,
    PERMISSIONS.CUSTOMER_PAY,
    PERMISSIONS.CUSTOMER_REVIEW,
  ]),

  TECHNICIAN: new Set<Permission>([
    PERMISSIONS.TECHNICIAN_ACCEPT_MISSION,
    PERMISSIONS.TECHNICIAN_UPDATE_STATUS,
    PERMISSIONS.TECHNICIAN_INSPECT,
    PERMISSIONS.TECHNICIAN_PROPOSE_EXTRA,
    PERMISSIONS.TECHNICIAN_HEALTH_REPORT,
    PERMISSIONS.TECHNICIAN_WITHDRAW,
  ]),

  FLEET_MANAGER: new Set<Permission>([
    PERMISSIONS.FLEET_VIEW_DASHBOARD,
    PERMISSIONS.FLEET_MANAGE_ASSETS,
    // Fleet managers are a specialized customer for B2B accounts; they also
    // inherit customer-side actions so they can book CARE services for their
    // fleet vehicles, approve extras, and pay invoices.
    PERMISSIONS.CUSTOMER_CREATE_SERVICE,
    PERMISSIONS.CUSTOMER_MANAGE_VEHICLES,
    PERMISSIONS.CUSTOMER_BOOK_CARE,
    PERMISSIONS.CUSTOMER_APPROVE_EXTRA,
    PERMISSIONS.CUSTOMER_PAY,
    PERMISSIONS.CUSTOMER_REVIEW,
  ]),

  PARTNER: new Set<Permission>([
    PERMISSIONS.PARTNER_VIEW_ANALYTICS,
  ]),

  ADMIN: new Set<Permission>([
    PERMISSIONS.ADMIN_ALL,
  ]),
};

// ──────────── Permission checks ────────────

/**
 * Returns true if `role` is allowed to perform `permission`.
 *
 * ADMIN short-circuits to `true` for any permission.
 * Unknown roles return `false` (deny-by-default).
 */
export function can(role: string | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  if (role === "ADMIN") return true;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  // ADMIN_ALL is a sentinel: any role that holds it is treated as a superuser.
  if (perms.has(PERMISSIONS.ADMIN_ALL)) return true;
  return perms.has(permission);
}

/**
 * Convenience overload: accepts a Session object so callers don't have to
 * unwrap `session.role` every time.
 *
 *   can(session, PERMISSIONS.CUSTOMER_PAY)
 */
export function canSession(session: { role: string } | null | undefined, permission: Permission): boolean {
  return can(session?.role, permission);
}

/**
 * Middleware-style guard. Returns a 403 NextResponse if the role lacks the
 * permission, or `null` if the caller may proceed.
 *
 *   const guard = requirePermission(session.role, PERMISSIONS.CUSTOMER_PAY);
 *   if (guard) return guard;
 *   // …proceed with handler…
 *
 * The 403 body is a Persian error message consistent with the rest of the API.
 */
export function requirePermission(role: string | undefined | null, permission: Permission): NextResponse | null {
  if (!can(role, permission)) {
    return NextResponse.json(
      { error: "دسترسی غیرمجاز — شما اجازه این عملیات را ندارید" },
      { status: 403 }
    );
  }
  return null;
}

/**
 * Same as requirePermission but takes a Session object (preferred in route
 * handlers that already have a Session in scope).
 */
export function requireSessionPermission(
  session: Session | null | undefined,
  permission: Permission
): NextResponse | null {
  return requirePermission(session?.role, permission);
}

// ──────────── Introspection helpers (used by admin UIs and tests) ────────────

/** Returns the set of permissions granted to a role. Does NOT include ADMIN bypass. */
export function permissionsForRole(role: string): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

/** Returns true if the role is recognized by the matrix. */
export function isKnownRole(role: string): boolean {
  return role in ROLE_PERMISSIONS;
}

/** Lists all roles known to the matrix. */
export function listRoles(): string[] {
  return Object.keys(ROLE_PERMISSIONS);
}
