// MEKANIX Phase 6 — Unit tests for the permission guard (@/lib/permissions)
//
// Covers the role → permission matrix from ARCHITECTURE.md §17:
//   - ADMIN can do everything (short-circuit)
//   - CUSTOMER can create services / manage vehicles / book CARE / approve extras /
//     pay / review, but cannot accept missions, inspect, or propose extras
//   - TECHNICIAN can accept missions / update status / inspect / propose extras /
//     write health reports / withdraw, but cannot create services or pay
//   - FLEET_MANAGER inherits CUSTOMER permissions (fleet B2B)
//   - PARTNER is read-only analytics viewer (single permission)
//   - Unknown role → deny by default
//   - requirePermission returns a 403 NextResponse for denied, null for allowed
import { describe, it, expect } from "vitest";
import {
  can,
  canSession,
  requirePermission,
  requireSessionPermission,
  PERMISSIONS,
  permissionsForRole,
  isKnownRole,
  listRoles,
} from "@/lib/permissions";
import type { Session } from "@/lib/auth";

describe("permissions — can()", () => {
  it("ADMIN short-circuits to true for any permission", () => {
    expect(can("ADMIN", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(true);
    expect(can("ADMIN", PERMISSIONS.PARTNER_VIEW_ANALYTICS)).toBe(true);
    // Even an "unknown" permission string should pass for ADMIN —
    // the spec is "ADMIN bypasses everything".
    expect(can("ADMIN", "some.future.permission")).toBe(true);
  });

  it("CUSTOMER can create services but not accept missions", () => {
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_MANAGE_VEHICLES)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_BOOK_CARE)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_APPROVE_EXTRA)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_PAY)).toBe(true);
    expect(can("CUSTOMER", PERMISSIONS.CUSTOMER_REVIEW)).toBe(true);

    // Customer CANNOT do technician things
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_UPDATE_STATUS)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_INSPECT)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_PROPOSE_EXTRA)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_HEALTH_REPORT)).toBe(false);
    expect(can("CUSTOMER", PERMISSIONS.TECHNICIAN_WITHDRAW)).toBe(false);
  });

  it("TECHNICIAN can accept missions but not create services", () => {
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(true);
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_UPDATE_STATUS)).toBe(true);
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_INSPECT)).toBe(true);
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_PROPOSE_EXTRA)).toBe(true);
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_HEALTH_REPORT)).toBe(true);
    expect(can("TECHNICIAN", PERMISSIONS.TECHNICIAN_WITHDRAW)).toBe(true);

    // Technician CANNOT do customer things
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(false);
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_MANAGE_VEHICLES)).toBe(false);
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_BOOK_CARE)).toBe(false);
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_APPROVE_EXTRA)).toBe(false);
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_PAY)).toBe(false);
    expect(can("TECHNICIAN", PERMISSIONS.CUSTOMER_REVIEW)).toBe(false);
  });

  it("FLEET_MANAGER inherits all customer permissions + has fleet-specific ones", () => {
    // Customer permissions inherited
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_MANAGE_VEHICLES)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_BOOK_CARE)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_APPROVE_EXTRA)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_PAY)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.CUSTOMER_REVIEW)).toBe(true);

    // Fleet-specific permissions
    expect(can("FLEET_MANAGER", PERMISSIONS.FLEET_VIEW_DASHBOARD)).toBe(true);
    expect(can("FLEET_MANAGER", PERMISSIONS.FLEET_MANAGE_ASSETS)).toBe(true);

    // Fleet manager is NOT a technician
    expect(can("FLEET_MANAGER", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(false);
    expect(can("FLEET_MANAGER", PERMISSIONS.TECHNICIAN_INSPECT)).toBe(false);

    // And NOT a partner
    expect(can("FLEET_MANAGER", PERMISSIONS.PARTNER_VIEW_ANALYTICS)).toBe(false);
  });

  it("PARTNER has only the analytics view permission", () => {
    expect(can("PARTNER", PERMISSIONS.PARTNER_VIEW_ANALYTICS)).toBe(true);
    // PARTNER has no other permissions
    expect(can("PARTNER", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(false);
    expect(can("PARTNER", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(false);
    expect(can("PARTNER", PERMISSIONS.FLEET_VIEW_DASHBOARD)).toBe(false);
    expect(can("PARTNER", PERMISSIONS.ADMIN_ALL)).toBe(false);
  });

  it("Unknown role has no permissions (deny by default)", () => {
    expect(can("SUPERUSER", PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(false);
    expect(can("anonymous", PERMISSIONS.PARTNER_VIEW_ANALYTICS)).toBe(false);
    expect(can("GUEST", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(false);
    expect(can("whatever", "any.permission")).toBe(false);
  });

  it("falsy role (undefined / null / empty) returns false", () => {
    expect(can(undefined, PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(false);
    expect(can(null, PERMISSIONS.ADMIN_ALL)).toBe(false);
    expect(can("", PERMISSIONS.PARTNER_VIEW_ANALYTICS)).toBe(false);
  });
});

describe("permissions — canSession()", () => {
  it("unwraps session.role", () => {
    expect(canSession({ role: "ADMIN" }, PERMISSIONS.CUSTOMER_PAY)).toBe(true);
    expect(canSession({ role: "CUSTOMER" }, PERMISSIONS.CUSTOMER_PAY)).toBe(true);
    expect(canSession({ role: "CUSTOMER" }, PERMISSIONS.TECHNICIAN_INSPECT)).toBe(false);
  });

  it("returns false for null/undefined sessions", () => {
    expect(canSession(null, PERMISSIONS.CUSTOMER_PAY)).toBe(false);
    expect(canSession(undefined, PERMISSIONS.CUSTOMER_PAY)).toBe(false);
  });
});

describe("permissions — requirePermission()", () => {
  it("returns null when allowed", () => {
    expect(requirePermission("CUSTOMER", PERMISSIONS.CUSTOMER_PAY)).toBeNull();
    expect(requirePermission("TECHNICIAN", PERMISSIONS.TECHNICIAN_INSPECT)).toBeNull();
    expect(requirePermission("ADMIN", "anything")).toBeNull();
  });

  it("returns a 403 NextResponse when denied", async () => {
    const guard = requirePermission("CUSTOMER", PERMISSIONS.TECHNICIAN_ACCEPT_MISSION);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
    const body = await guard!.json();
    expect(body).toHaveProperty("error");
  });

  it("returns a 403 for unknown role", async () => {
    const guard = requirePermission("UNKNOWN_ROLE", PERMISSIONS.CUSTOMER_PAY);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });

  it("returns a 403 for undefined role", async () => {
    const guard = requirePermission(undefined, PERMISSIONS.CUSTOMER_PAY);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });
});

describe("permissions — requireSessionPermission()", () => {
  // `requireSessionPermission` takes a full `Session` (userId/role/phone/isGuest),
  // so we use a minimal-but-complete session object here.
  const customerSession: Session = {
    userId: "user_1",
    role: "CUSTOMER",
    phone: "+989121234567",
    isGuest: false,
  };

  it("returns null when session has the permission", () => {
    expect(
      requireSessionPermission(customerSession, PERMISSIONS.CUSTOMER_PAY)
    ).toBeNull();
  });

  it("returns 403 when session lacks the permission", async () => {
    const guard = requireSessionPermission(
      customerSession,
      PERMISSIONS.TECHNICIAN_ACCEPT_MISSION
    );
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });

  it("returns 403 when session is null", async () => {
    const guard = requireSessionPermission(null, PERMISSIONS.CUSTOMER_PAY);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(403);
  });
});

describe("permissions — introspection helpers", () => {
  it("permissionsForRole returns the set (not including ADMIN bypass)", () => {
    const customerPerms = permissionsForRole("CUSTOMER");
    expect(customerPerms.has(PERMISSIONS.CUSTOMER_CREATE_SERVICE)).toBe(true);
    expect(customerPerms.has(PERMISSIONS.TECHNICIAN_ACCEPT_MISSION)).toBe(false);
    expect(customerPerms.size).toBe(6);
  });

  it("permissionsForRole returns empty set for unknown role", () => {
    expect(permissionsForRole("ALIEN").size).toBe(0);
  });

  it("isKnownRole returns true for the five canonical roles", () => {
    expect(isKnownRole("CUSTOMER")).toBe(true);
    expect(isKnownRole("TECHNICIAN")).toBe(true);
    expect(isKnownRole("ADMIN")).toBe(true);
    expect(isKnownRole("FLEET_MANAGER")).toBe(true);
    expect(isKnownRole("PARTNER")).toBe(true);
    expect(isKnownRole("ALIEN")).toBe(false);
  });

  it("listRoles returns all known roles", () => {
    const roles = listRoles();
    expect(roles).toContain("CUSTOMER");
    expect(roles).toContain("TECHNICIAN");
    expect(roles).toContain("ADMIN");
    expect(roles).toContain("FLEET_MANAGER");
    expect(roles).toContain("PARTNER");
    expect(roles.length).toBe(5);
  });
});
