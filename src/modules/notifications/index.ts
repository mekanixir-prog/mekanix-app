// MEKANIX — Notifications module barrel.
//
// Re-exports the centralized notification type catalogue and the
// `sendNotification` helper from `src/lib/notifications.ts`. Also pulls in
// the Prisma-derived Notification domain type and the BOLA helper that
// guards access to a single notification.

export {
  NOTIFICATION_TYPES,
  sendNotification,
  type NotificationType,
} from "@/lib/notifications";

export {
  type Notification,
} from "@/lib/api";

export {
  requireNotificationOwner,
  type Session,
} from "@/lib/auth";
