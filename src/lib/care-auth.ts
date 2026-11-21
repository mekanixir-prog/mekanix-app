// MEKANIX CARE — Authorization helpers + State Machine for ServiceBookings
// Implements BOLA (Broken Object Level Authorization) protection for all CARE endpoints.
//
// Permission matrix:
//   ADMIN     → unrestricted access to all bookings
//   CUSTOMER  → only bookings they own (booking.userId === session.userId)
//   TECHNICIAN → only bookings assigned to them (booking.technicianId === technician.id)

import { NextResponse } from "next/server";
import { getDbForLib } from "./db-access";
import type { Session } from "./auth";
import { getCustomerFromSession, getTechnicianFromSession } from "./auth";

// ──────────── Booking Participant Authorization ────────────
// Returns null if authorized, or NextResponse(403) if forbidden.
// Throws nothing — all errors are returned as NextResponse.

export async function requireBookingParticipant(
  session: Session,
  bookingId: string
): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;

  const db = await getDbForLib();
  const booking = await db.serviceBooking.findUnique({
    where: { id: bookingId },
    select: { id: true, userId: true, technicianId: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  if (session.role === "CUSTOMER") {
    if (booking.userId !== session.userId) {
      return NextResponse.json({ error: "دسترسی به این سفارش مجاز نیست" }, { status: 403 });
    }
    return null;
  }

  if (session.role === "TECHNICIAN") {
    const technician = await getTechnicianFromSession(session);
    if (!technician) {
      return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
    }
    // technicianId on booking references Technician.id (NOT User.id)
    if (booking.technicianId !== technician.id) {
      return NextResponse.json({ error: "شما به این سفارش اختصاص ندارید" }, { status: 403 });
    }
    return null;
  }

  return NextResponse.json({ error: "نقش کاربری نامعتبر" }, { status: 403 });
}

// ──────────── Technician-Only Authorization ────────────
// Verifies the session is a TECHNICIAN (or ADMIN) AND is the assigned technician
// for the given booking. Used for write operations (inspection, findings, proposals).

export async function requireAssignedTechnician(
  session: Session,
  bookingId: string
): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;

  if (session.role !== "TECHNICIAN") {
    return NextResponse.json({ error: "این عملیات فقط برای مکانیک مجاز است" }, { status: 403 });
  }

  const technician = await getTechnicianFromSession(session);
  if (!technician) {
    return NextResponse.json({ error: "پروفایل مکانیک یافت نشد" }, { status: 403 });
  }

  const db = await getDbForLib();
  const booking = await db.serviceBooking.findUnique({
    where: { id: bookingId },
    select: { id: true, technicianId: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  // Booking must have a technician assigned AND it must be this technician
  if (!booking.technicianId || booking.technicianId !== technician.id) {
    return NextResponse.json({ error: "شما به این سفارش اختصاص ندارید" }, { status: 403 });
  }

  return null;
}

// ──────────── Booking Owner Authorization ────────────
// Verifies the session is the CUSTOMER who owns the booking (or ADMIN).
// Used for approval/rejection operations.

export async function requireBookingOwner(
  session: Session,
  bookingId: string
): Promise<NextResponse | null> {
  if (session.role === "ADMIN") return null;

  if (session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "این عملیات فقط برای مشتری مجاز است" }, { status: 403 });
  }

  const db = await getDbForLib();
  const booking = await db.serviceBooking.findUnique({
    where: { id: bookingId },
    select: { id: true, userId: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }

  if (booking.userId !== session.userId) {
    return NextResponse.json({ error: "این سفارش متعلق به شما نیست" }, { status: 403 });
  }

  return null;
}

// ──────────── ServiceBooking State Machine ────────────
// Per-state-machine spec from MEKANIX CARE design doc:
//   REQUESTED → SCHEDULED → MATCHING → ASSIGNED → EN_ROUTE → ARRIVED
//            → INSPECTING → WAITING_CUSTOMER_APPROVAL → APPROVED
//            → IN_SERVICE → FINAL_CHECK → COMPLETED
//   (any pre-COMPLETED state → CANCELLED)
//   (FINAL_CHECK → COMPLETED only, no backwards)

export type BookingStatus =
  | "REQUESTED"
  | "SCHEDULED"
  | "MATCHING"
  | "ASSIGNED"
  | "EN_ROUTE"
  | "ARRIVED"
  | "INSPECTING"
  | "WAITING_CUSTOMER_APPROVAL"
  | "APPROVED"
  | "IN_SERVICE"
  | "FINAL_CHECK"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

// Allowed transitions per role
// Format: { from: [allowed next states] }
//
// Notes on extra-proposal workflow:
//   - INSPECTING → WAITING_CUSTOMER_APPROVAL: technician proposes extra during inspection.
//   - IN_SERVICE  → WAITING_CUSTOMER_APPROVAL: technician proposes extra mid-service.
//   - WAITING_CUSTOMER_APPROVAL → INSPECTING: customer rejected the extra; technician re-inspects.
//   - WAITING_CUSTOMER_APPROVAL → APPROVED:    customer approved the extra.
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  REQUESTED: ["SCHEDULED", "CANCELLED", "FAILED"],
  SCHEDULED: ["MATCHING", "CANCELLED", "FAILED"],
  MATCHING: ["ASSIGNED", "CANCELLED", "FAILED"],
  ASSIGNED: ["EN_ROUTE", "CANCELLED", "FAILED"],
  EN_ROUTE: ["ARRIVED", "CANCELLED", "FAILED"],
  ARRIVED: ["INSPECTING", "CANCELLED", "FAILED"],
  INSPECTING: ["WAITING_CUSTOMER_APPROVAL", "IN_SERVICE", "CANCELLED", "FAILED"],
  WAITING_CUSTOMER_APPROVAL: ["APPROVED", "IN_SERVICE", "INSPECTING", "CANCELLED", "FAILED"],
  APPROVED: ["IN_SERVICE", "CANCELLED", "FAILED"],
  IN_SERVICE: ["FINAL_CHECK", "WAITING_CUSTOMER_APPROVAL", "CANCELLED", "FAILED"],
  FINAL_CHECK: ["COMPLETED", "FAILED"],
  COMPLETED: [], // terminal
  CANCELLED: [], // terminal
  FAILED: [],    // terminal
};

// Role → allowed transitions (subset)
// - ADMIN can do any transition
// - CUSTOMER can only: CANCEL (pre-service), APPROVE (approve extra cost),
//   and INSPECTING (reject extra cost — back to technician for re-inspection)
// - FLEET_MANAGER mirrors CUSTOMER (they manage a fleet of vehicles on the
//   customer side and can approve extras / cancel pre-service bookings for
//   their fleet) — see ARCHITECTURE.md §5 Roles.
// - PARTNER is a read-only analytics viewer — no booking transitions.
const ROLE_TRANSITIONS: Record<Session["role"], Set<BookingStatus>> = {
  ADMIN: new Set<BookingStatus>([
    "SCHEDULED", "MATCHING", "ASSIGNED", "EN_ROUTE", "ARRIVED",
    "INSPECTING", "WAITING_CUSTOMER_APPROVAL", "APPROVED", "IN_SERVICE",
    "FINAL_CHECK", "COMPLETED", "CANCELLED", "FAILED",
  ]),
  CUSTOMER: new Set<BookingStatus>(["CANCELLED", "APPROVED", "INSPECTING"]),
  FLEET_MANAGER: new Set<BookingStatus>(["CANCELLED", "APPROVED", "INSPECTING"]),
  TECHNICIAN: new Set<BookingStatus>([
    "EN_ROUTE", "ARRIVED", "INSPECTING", "WAITING_CUSTOMER_APPROVAL",
    "IN_SERVICE", "FINAL_CHECK", "COMPLETED", "FAILED",
  ]),
  PARTNER: new Set<BookingStatus>([]),
};

export function isValidTransition(
  role: Session["role"],
  currentStatus: string,
  nextStatus: string
): boolean {
  const current = currentStatus as BookingStatus;
  const next = nextStatus as BookingStatus;

  // Validate the transition is in the state machine
  const allowed = TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    return false;
  }

  // Validate the role is permitted to make this transition
  const roleAllowed = ROLE_TRANSITIONS[role];
  if (!roleAllowed.has(next)) {
    return false;
  }

  // FLEET_MANAGER mirrors CUSTOMER for the booking flow (approve extras /
  // reject extras / cancel pre-service) — see ARCHITECTURE.md §5 Roles.
  const actsAsCustomer = role === "CUSTOMER" || role === "FLEET_MANAGER";

  // Special case: customer-side role can only APPROVE when status is WAITING_CUSTOMER_APPROVAL
  if (actsAsCustomer && next === "APPROVED" && current !== "WAITING_CUSTOMER_APPROVAL") {
    return false;
  }

  // Special case: customer-side role can only transition to INSPECTING when
  // rejecting an extra (i.e. the booking must currently be WAITING_CUSTOMER_APPROVAL).
  if (actsAsCustomer && next === "INSPECTING" && current !== "WAITING_CUSTOMER_APPROVAL") {
    return false;
  }

  // Special case: customer-side role can only CANCEL before IN_SERVICE
  if (actsAsCustomer && next === "CANCELLED" &&
      ["IN_SERVICE", "FINAL_CHECK", "COMPLETED", "CANCELLED", "FAILED"].includes(current)) {
    return false;
  }

  return true;
}

// Validate a transition and return a NextResponse error if invalid
export function validateTransition(
  role: Session["role"],
  currentStatus: string,
  nextStatus: string
): NextResponse | null {
  if (!isValidTransition(role, currentStatus, nextStatus)) {
    return NextResponse.json(
      {
        error: `انتقال وضعیت مجاز نیست: ${currentStatus} → ${nextStatus} برای نقش ${role}`,
        currentStatus,
        nextStatus,
      },
      { status: 409 }
    );
  }
  return null;
}

// ──────────── Customer Approval Status Machine ────────────

export type ApprovalStatus = "PROPOSED" | "CUSTOMER_APPROVED" | "CUSTOMER_REJECTED";

export const APPROVAL_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  PROPOSED: ["CUSTOMER_APPROVED", "CUSTOMER_REJECTED"],
  CUSTOMER_APPROVED: [], // terminal
  CUSTOMER_REJECTED: [],  // terminal
};

export function isValidApprovalTransition(
  current: string,
  next: string
): boolean {
  const allowed = APPROVAL_TRANSITIONS[current as ApprovalStatus] ?? [];
  return allowed.includes(next as ApprovalStatus);
}
