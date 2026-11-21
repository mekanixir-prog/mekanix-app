// MEKANIX — Centralized notification type catalogue + helper.
//
// This module is the single source of truth for notification `type` strings
// stored on the Notification table (prisma/schema.prisma §Notification.type).
// Before this file existed, type strings were scattered ad-hoc across route
// handlers (`"job_completed"`, `"request_accepted"`, etc.) — easy to typo and
// impossible to grep exhaustively.
//
// Usage:
//   import { sendNotification, NOTIFICATION_TYPES } from "@/lib/notifications";
//   await sendNotification({
//     userId: customer.id,
//     type: NOTIFICATION_TYPES.JOB_COMPLETED,
//     title: "کار تکمیل شد",
//     body: `${tech.name} کار را تکمیل کرد.`,
//     category: "job",
//     link: "customer/invoice",
//   });
//
// Adding a new notification type:
//   1. Append a new entry to the `NOTIFICATION_TYPES` const below.
//   2. Update any consumer code (UI badge colors, filtering, etc.) that
//      branches on the type string.
//   3. No DB migration needed — `Notification.type` is a free-form string.

import { getDbForLib } from "./db-access";

// ──────────── Notification type catalogue ────────────
// `as const` so the derived `NotificationType` union is a literal union of
// the exact strings (no widening to `string`).
export const NOTIFICATION_TYPES = {
  // Auth
  OTP_SENT: "otp_sent",
  // Service (on-demand repair flow)
  REQUEST_ACCEPTED: "request_accepted",
  TECHNICIAN_ARRIVING: "technician_arriving",
  JOB_COMPLETED: "job_completed",
  REQUEST_REJECTED: "request_rejected",
  // Payment
  PAYMENT_REQUIRED: "payment_required",
  PAYMENT_RECEIVED: "payment_received",
  WITHDRAWAL_PROCESSED: "withdrawal_processed",
  // CARE (scheduled maintenance)
  EXTRA_PROPOSAL: "extra_proposal",
  BOOKING_CONFIRMED: "booking_confirmed",
  SERVICE_REMINDER: "service_reminder",
  // Warranty
  WARRANTY_ACTIVATED: "warranty_activated",
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

// ──────────── Helper: create a notification row ────────────
// Thin wrapper around `db.notification.create` so callers don't have to
// remember the column names (`category` defaults to "general", `link` is
// nullable). Centralizing this also makes it easy to add cross-cutting
// concerns later (e.g. push delivery, fan-out to multiple users, locale
// translation of the title/body) without touching every call site.
export async function sendNotification(params: {
  userId: string;
  type: string;
  title: string;
  body: string;
  category?: string;
  link?: string;
}) {
  const db = await getDbForLib();
  return db.notification.create({
    data: {
      userId: params.userId,
      type: params.type,
      title: params.title,
      body: params.body,
      category: params.category ?? "general",
      link: params.link ?? null,
    },
  });
}
