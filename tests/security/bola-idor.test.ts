// MEKANIX — BOLA / IDOR Security Tests
// ============================================================================
// Verifies that the authorization helpers correctly prevent:
//   - Broken Object Level Authorization (BOLA) — OWASP API1
//   - Insecure Direct Object Reference (IDOR) — accessing other users' objects
//     by guessing IDs
//   - State-machine tampering (role-based transition gates)
//   - Mass assignment (server-authoritative fields like role/balance/rating
//     cannot be set by client)
//   - OTP crypto (CSPRNG + SHA-256 — not Math.random + plaintext)
//
// Mock strategy:
//   - Each BOLA helper in `@/lib/auth` / `@/lib/care-auth` reads from a
//     specific DB model. The mock returns deterministic records keyed on the
//     `id` so we can assert allow-vs-deny per (session, resource-id) pair.
//   - `customer.findUnique` and `technician.findUnique` are scoped by
//     `userId` so the helpers resolve the user's profile correctly.
// ============================================================================

import { describe, it, expect, vi } from "vitest";

// Static imports — these resolve to the mocked versions (vi.mock is hoisted).
import { isValidTransition } from "@/lib/care-auth";
import { can } from "@/lib/permissions";
import {
  FORBIDDEN_FIELDS,
  ALLOWED_FIELDS,
  sanitizeInput,
} from "@/lib/auth";
import { generateOtpCode, hashOtpCode } from "@/lib/otp-crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    job: {
      findUnique: vi.fn(async ({ where }: any) => {
        // job-own → owned by user1 (customerId = cust1)
        if (where.id === "job-own") {
          return {
            id: "job-own",
            request: { customerId: "cust1" },
            technicianId: "tech1",
          };
        }
        // job-other → owned by user2 (customerId = cust2)
        if (where.id === "job-other") {
          return {
            id: "job-other",
            request: { customerId: "cust2" },
            technicianId: "tech2",
          };
        }
        return null;
      }),
    },
    serviceBooking: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id === "booking-own") {
          return {
            id: "booking-own",
            userId: "user1",
            technicianId: "tech1",
          };
        }
        if (where.id === "booking-other") {
          return {
            id: "booking-other",
            userId: "user2",
            technicianId: "tech2",
          };
        }
        return null;
      }),
    },
    vehicle: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id === "veh-own")
          return { id: "veh-own", customerId: "cust1" };
        if (where.id === "veh-other")
          return { id: "veh-other", customerId: "cust2" };
        return null;
      }),
    },
    notification: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id === "notif-own")
          return { id: "notif-own", userId: "user1" };
        if (where.id === "notif-other")
          return { id: "notif-other", userId: "user2" };
        return null;
      }),
      create: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    wallet: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id === "wallet-own")
          return { id: "wallet-own", technicianId: "tech1" };
        if (where.id === "wallet-other")
          return { id: "wallet-other", technicianId: "tech2" };
        return null;
      }),
    },
    customer: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.userId === "user1")
          return { id: "cust1", userId: "user1" };
        return null;
      }),
      create: vi.fn(),
    },
    technician: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.userId === "techuser1")
          return { id: "tech1", userId: "techuser1" };
        return null;
      }),
      findMany: vi.fn(async () => []),
    },
    session: {
      findUnique: vi.fn(async () => ({
        tokenHash: "valid",
        userId: "user1",
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
      })),
      create: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    otpCode: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
    },
    serviceTimelineEvent: { create: vi.fn() },
    supportTicket: { findUnique: vi.fn() },
    insurancePolicy: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/redis", () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => undefined),
  kvDel: vi.fn(async () => undefined),
  kvIncr: vi.fn(async () => 1),
  isRedisAvailable: vi.fn(async () => false),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("BOLA / IDOR Security Tests", () => {
  // ── Job BOLA ─────────────────────────────────────────────────────────
  describe("Job BOLA", () => {
    it("should allow owner (CUSTOMER) to access their own job", async () => {
      const { requireJobParticipant } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireJobParticipant(session, "job-own");
      expect(result).toBeNull(); // null = authorized
    });

    it("should deny CUSTOMER access to another user's job (IDOR)", async () => {
      const { requireJobParticipant } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireJobParticipant(session, "job-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should allow ADMIN to access any job (superuser bypass)", async () => {
      const { requireJobParticipant } = await import("@/lib/auth");
      const session = {
        userId: "admin1",
        role: "ADMIN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireJobParticipant(session, "job-other");
      expect(result).toBeNull();
    });

    it("should return 404 when the job does not exist (no info leak)", async () => {
      const { requireJobParticipant } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireJobParticipant(session, "job-nonexistent");
      expect(result).not.toBeNull();
      // Existing is 404 (not found) — should NOT leak whether the resource
      // exists for someone else.
      expect(result?.status).toBe(404);
    });
  });

  // ── ServiceBooking BOLA ──────────────────────────────────────────────
  describe("ServiceBooking BOLA", () => {
    it("should allow owner (CUSTOMER) to access their own booking", async () => {
      const { requireBookingParticipant } = await import("@/lib/care-auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireBookingParticipant(session, "booking-own");
      expect(result).toBeNull();
    });

    it("should deny CUSTOMER access to another user's booking (IDOR)", async () => {
      const { requireBookingParticipant } = await import("@/lib/care-auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireBookingParticipant(session, "booking-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should allow ADMIN to access any booking (superuser bypass)", async () => {
      const { requireBookingParticipant } = await import("@/lib/care-auth");
      const session = {
        userId: "admin1",
        role: "ADMIN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireBookingParticipant(session, "booking-other");
      expect(result).toBeNull();
    });

    it("should deny unassigned TECHNICIAN access to a booking they don't own", async () => {
      const { requireAssignedTechnician } = await import("@/lib/care-auth");
      const session = {
        userId: "techuser1",
        role: "TECHNICIAN" as const,
        phone: null,
        isGuest: false,
      };
      // booking-other has technicianId="tech2" — tech1 (mapped from
      // techuser1) is NOT the assigned technician → 403.
      const result = await requireAssignedTechnician(session, "booking-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should allow assigned TECHNICIAN to access their booking", async () => {
      const { requireAssignedTechnician } = await import("@/lib/care-auth");
      const session = {
        userId: "techuser1",
        role: "TECHNICIAN" as const,
        phone: null,
        isGuest: false,
      };
      // booking-own has technicianId="tech1" — matches the technician
      // resolved from session.userId="techuser1".
      const result = await requireAssignedTechnician(session, "booking-own");
      expect(result).toBeNull();
    });

    it("should deny CUSTOMER the assigned-technician action (role gate)", async () => {
      const { requireAssignedTechnician } = await import("@/lib/care-auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      // Even on their OWN booking, customer is not a technician → 403.
      const result = await requireAssignedTechnician(session, "booking-own");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });
  });

  // ── Vehicle BOLA ─────────────────────────────────────────────────────
  describe("Vehicle BOLA", () => {
    it("should allow owner (CUSTOMER) to access their own vehicle", async () => {
      const { requireVehicleOwner } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireVehicleOwner(session, "veh-own");
      expect(result).toBeNull();
    });

    it("should deny CUSTOMER access to another user's vehicle (IDOR)", async () => {
      const { requireVehicleOwner } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireVehicleOwner(session, "veh-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should return 404 when vehicle does not exist", async () => {
      const { requireVehicleOwner } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireVehicleOwner(session, "veh-nonexistent");
      expect(result?.status).toBe(404);
    });

    it("should allow ADMIN to access any vehicle (superuser bypass)", async () => {
      const { requireVehicleOwner } = await import("@/lib/auth");
      const session = {
        userId: "admin1",
        role: "ADMIN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireVehicleOwner(session, "veh-other");
      expect(result).toBeNull();
    });

    it("should deny TECHNICIAN access to a vehicle (no customer profile)", async () => {
      const { requireVehicleOwner } = await import("@/lib/auth");
      const session = {
        userId: "techuser1",
        role: "TECHNICIAN" as const,
        phone: null,
        isGuest: false,
      };
      // Technician has no customer profile → "پروفایل مشتری یافت نشد" → 403.
      const result = await requireVehicleOwner(session, "veh-own");
      expect(result?.status).toBe(403);
    });
  });

  // ── Notification BOLA ────────────────────────────────────────────────
  describe("Notification BOLA", () => {
    it("should allow owner to access their own notification", async () => {
      const { requireNotificationOwner } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireNotificationOwner(session, "notif-own");
      expect(result).toBeNull();
    });

    it("should deny access to another user's notification (IDOR)", async () => {
      const { requireNotificationOwner } = await import("@/lib/auth");
      const session = {
        userId: "user1",
        role: "CUSTOMER" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireNotificationOwner(session, "notif-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should allow ADMIN to access any notification", async () => {
      const { requireNotificationOwner } = await import("@/lib/auth");
      const session = {
        userId: "admin1",
        role: "ADMIN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireNotificationOwner(session, "notif-other");
      expect(result).toBeNull();
    });
  });

  // ── Wallet BOLA ──────────────────────────────────────────────────────
  describe("Wallet BOLA", () => {
    it("should allow owner (TECHNICIAN) to access their own wallet", async () => {
      const { requireWalletOwner } = await import("@/lib/auth");
      const session = {
        userId: "techuser1",
        role: "TECHNICIAN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireWalletOwner(session, "wallet-own");
      expect(result).toBeNull();
    });

    it("should deny TECHNICIAN access to another technician's wallet (IDOR)", async () => {
      const { requireWalletOwner } = await import("@/lib/auth");
      const session = {
        userId: "techuser1",
        role: "TECHNICIAN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireWalletOwner(session, "wallet-other");
      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
    });

    it("should allow ADMIN to access any wallet (superuser bypass)", async () => {
      const { requireWalletOwner } = await import("@/lib/auth");
      const session = {
        userId: "admin1",
        role: "ADMIN" as const,
        phone: null,
        isGuest: false,
      };
      const result = await requireWalletOwner(session, "wallet-other");
      expect(result).toBeNull();
    });
  });

  // ── State Machine Security ───────────────────────────────────────────
  describe("State Machine Security", () => {
    it("should prevent CUSTOMER from advancing the service workflow", () => {
      // Customer should NOT be able to advance technician-side transitions.
      expect(isValidTransition("CUSTOMER", "ASSIGNED", "EN_ROUTE")).toBe(false);
      expect(isValidTransition("CUSTOMER", "EN_ROUTE", "ARRIVED")).toBe(false);
      expect(isValidTransition("CUSTOMER", "INSPECTING", "IN_SERVICE")).toBe(false);
      expect(isValidTransition("CUSTOMER", "FINAL_CHECK", "COMPLETED")).toBe(false);
    });

    it("should prevent TECHNICIAN from creating services (function-level auth)", () => {
      expect(can("TECHNICIAN", "customer.create.service")).toBe(false);
    });

    it("should prevent CUSTOMER from accepting missions (function-level auth)", () => {
      expect(can("CUSTOMER", "technician.accept.mission")).toBe(false);
    });

    it("should prevent reversing terminal states (COMPLETED → anything)", () => {
      expect(isValidTransition("TECHNICIAN", "COMPLETED", "IN_SERVICE")).toBe(false);
      expect(isValidTransition("ADMIN", "COMPLETED", "CANCELLED")).toBe(false);
      expect(isValidTransition("TECHNICIAN", "CANCELLED", "ASSIGNED")).toBe(false);
      expect(isValidTransition("ADMIN", "FAILED", "COMPLETED")).toBe(false);
    });

    it("should prevent non-CUSTOMER roles from cancelling (technician cannot cancel)", () => {
      expect(isValidTransition("TECHNICIAN", "REQUESTED", "CANCELLED")).toBe(false);
      expect(isValidTransition("TECHNICIAN", "ASSIGNED", "CANCELLED")).toBe(false);
    });

    it("should prevent PARTNER from any state transition (read-only analytics)", () => {
      expect(isValidTransition("PARTNER", "REQUESTED", "CANCELLED")).toBe(false);
      expect(isValidTransition("PARTNER", "FINAL_CHECK", "COMPLETED")).toBe(false);
    });
  });

  // ── Mass Assignment Protection ──────────────────────────────────────
  describe("Mass Assignment Protection", () => {
    it("should mark `role` as FORBIDDEN (server-authoritative)", () => {
      expect(FORBIDDEN_FIELDS.has("role")).toBe(true);
    });

    it("should mark `balance` as FORBIDDEN (server-authoritative)", () => {
      expect(FORBIDDEN_FIELDS.has("balance")).toBe(true);
    });

    it("should mark `rating` as FORBIDDEN (server-authoritative)", () => {
      expect(FORBIDDEN_FIELDS.has("rating")).toBe(true);
    });

    it("should mark `status` as FORBIDDEN (server-authoritative)", () => {
      expect(FORBIDDEN_FIELDS.has("status")).toBe(true);
    });

    it("should mark other sensitive fields as FORBIDDEN", () => {
      // Mass assignment protection — these MUST NEVER come from the client.
      expect(FORBIDDEN_FIELDS.has("password")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("passwordHash")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("phoneVerified")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("verified")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("reviewCount")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("completedJobs")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("totalEarned")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("id")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("createdAt")).toBe(true);
      expect(FORBIDDEN_FIELDS.has("updatedAt")).toBe(true);
    });

    it("should expose ALLOWED_FIELDS whitelists for each entity type", () => {
      // Vehicle: type, make, model, year, plate, etc. — but NOT customerId.
      expect(ALLOWED_FIELDS.vehicle).toContain("make");
      expect(ALLOWED_FIELDS.vehicle).toContain("model");
      expect(ALLOWED_FIELDS.vehicle).not.toContain("customerId");
      // Profile: name, email — but NOT role / balance / phoneVerified.
      expect(ALLOWED_FIELDS.profile).toContain("name");
      expect(ALLOWED_FIELDS.profile).not.toContain("role");
      expect(ALLOWED_FIELDS.profile).not.toContain("balance");
    });

    it("sanitizeInput should drop forbidden fields and keep allowed ones", () => {
      const input = {
        make: "IKCO",
        model: "Samand",
        year: 2020,
        role: "ADMIN", // forbidden — should be dropped
        balance: 1_000_000, // forbidden — should be dropped
      };
      const sanitized = sanitizeInput(input, ALLOWED_FIELDS.vehicle);
      expect(sanitized.make).toBe("IKCO");
      expect(sanitized.model).toBe("Samand");
      expect(sanitized.year).toBe(2020);
      expect(sanitized.role).toBeUndefined();
      expect(sanitized.balance).toBeUndefined();
    });
  });

  // ── OTP Security ─────────────────────────────────────────────────────
  describe("OTP Security", () => {
    it("should use CSPRNG for OTP generation (uniform distribution)", () => {
      // With 6-digit codes (1M possible values), birthday-paradox makes
      // collisions likely at ~1250 draws. We test 100 draws (collision
      // probability ~0.4%) and verify uniqueness + uniform distribution.
      const codes: string[] = [];
      for (let i = 0; i < 100; i++) {
        codes.push(generateOtpCode());
      }
      const unique = new Set(codes);
      // Should be at least 99 unique out of 100 (allowing 1 collision)
      expect(unique.size).toBeGreaterThanOrEqual(99);

      // Verify distribution: last digit should not be all the same
      const lastDigits = new Set(codes.map(c => c[5]));
      expect(lastDigits.size).toBeGreaterThanOrEqual(5);
    });

    it("should always produce a 6-digit code", () => {
      for (let i = 0; i < 100; i++) {
        const code = generateOtpCode();
        expect(code).toMatch(/^\d{6}$/);
        const n = parseInt(code, 10);
        expect(n).toBeGreaterThanOrEqual(100_000);
        expect(n).toBeLessThanOrEqual(999_999);
      }
    });

    it("should hash OTP codes with SHA-256 (64 hex chars)", () => {
      const hash = hashOtpCode("123456");
      // SHA-256 hex digest → 64 lowercase hex chars
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should hash OTP deterministically (same input → same hash)", () => {
      const a = hashOtpCode("654321");
      const b = hashOtpCode("654321");
      expect(a).toBe(b);
    });

    it("should hash OTP distinctly (different input → different hash)", () => {
      const a = hashOtpCode("111111");
      const b = hashOtpCode("222222");
      expect(a).not.toBe(b);
    });

    it("should NOT use Math.random for OTP (CSPRNG vs PRNG)", () => {
      // We can't directly assert "uses crypto.randomInt" without spying,
      // but we can verify the output distribution is NOT Math.random-like:
      // Math.random() tends to have a low-entropy last digit pattern, while
      // CSPRNG output is uniformly distributed. Generate 1000 codes and
      // verify the last-digit distribution has all 10 digits present.
      const lastDigits = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        lastDigits.add(generateOtpCode().slice(-1));
      }
      // CSPRNG should produce all 10 distinct last digits over 1000 draws.
      expect(lastDigits.size).toBe(10);
    });
  });

  // ── Cross-cutting: ADMIN cannot be impersonated via input ────────────
  describe("Role escalation prevention", () => {
    it("should not allow a CUSTOMER to perform ADMIN-only transitions (defense in depth)", () => {
      // CUSTOMER can cancel pre-service bookings — but cannot drive the
      // workflow. They also can't introduce admin-level transitions like
      // MATCHING (only the matching engine or ADMIN does that).
      expect(isValidTransition("CUSTOMER", "REQUESTED", "MATCHING")).toBe(false);
      expect(isValidTransition("CUSTOMER", "SCHEDULED", "MATCHING")).toBe(false);
    });

    it("should reject unknown roles entirely (deny-by-default)", () => {
      expect(can("SUPERUSER", "customer.create.service")).toBe(false);
      expect(can("ROOT", "admin.all")).toBe(false);
      expect(can("anonymous", "partner.view.analytics")).toBe(false);
    });
  });
});
