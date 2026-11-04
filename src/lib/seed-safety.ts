/**
 * Guard the destructive demo seed script against non-empty databases.
 *
 * The seed script deletes and recreates demo records. It must never run against
 * production or against a database that contains any application data,
 * including orphaned financial rows without a User record.
 */
export const SEED_PROTECTED_MODEL_DELEGATES = [
  "user", "session", "customer", "technician", "technicianSpecialty",
  "certification", "serviceArea", "vehicle", "serviceRequest", "job",
  "diagnosis", "part", "trackingEvent", "invoice", "payment", "review",
  "message", "notification", "warranty", "serviceCategory", "otpCode",
  "mechanicApplication", "maintenanceSchedule", "referral", "insurancePolicy",
  "insuranceClaim", "supportTicket", "wallet", "walletTransaction",
  "withdrawalRequest", "vipPlan", "userVipSubscription", "paymentGatewayLog",
  "platformSetting", "adminUser", "onboardingSlide", "auditLog",
  "exchangeRateHistory", "discountCode", "banner", "pushNotification",
  "walletLedger", "vehicleCareProfile", "maintenanceRule",
  "maintenanceScheduleItem", "servicePackage", "servicePackageItem",
  "serviceBooking", "serviceTimelineEvent", "inspection", "finding",
  "customerApproval", "partUsage", "pricingSnapshot", "vehicleHealthReport",
  "technicianCapability", "dispatchCandidate", "careSubscription",
  "careReminder", "rateLimit", "idempotencyKey", "walletReleaseWorkerState",
  "walletReleaseGuard",
] as const;

/**
 * Refuse demo setup unless the operator explicitly opts in on a disposable
 * local database. NODE_ENV alone is not a reliable production boundary:
 * shell sessions and one-off commands may not inherit the app's runtime env.
 */
export function assertDemoSetupAllowed(
  nodeEnv: string | undefined,
  allowDemoSetup: string | undefined,
): void {
  if (nodeEnv === "production") {
    throw new Error("Demo database setup is disabled in production. No schema push or seed was run.");
  }
  if (allowDemoSetup !== "true") {
    throw new Error(
      "Demo database setup requires MEKANIX_ALLOW_DEMO_SETUP=true and a disposable local database. No schema push or seed was run.",
    );
  }
}

type CountDelegate = { count: () => Promise<number> };

export async function assertDatabaseEmptyForDemoSeed(db: unknown): Promise<void> {
  if (!db || typeof db !== "object") {
    throw new TypeError("A database client is required before running the demo seed");
  }

  const client = db as Record<string, unknown>;
  const counts = await Promise.all(
    SEED_PROTECTED_MODEL_DELEGATES.map(async (modelName) => {
      const delegate = client[modelName] as CountDelegate | undefined;
      if (!delegate || typeof delegate.count !== "function") {
        throw new Error(`Cannot verify demo-seed safety: database delegate ${modelName} is unavailable`);
      }
      return [modelName, await delegate.count()] as const;
    }),
  );

  const populated = counts.filter(([, count]) => count > 0);
  if (populated.length > 0) {
    const summary = populated.map(([name, count]) => `${name}=${count}`).join(", ");
    throw new Error(
      `Refusing destructive demo seed: database is not empty (${summary}). Use a fresh disposable database.`,
    );
  }
}
