-- Preserve the VIP entitlement duration agreed at payment initiation.
-- Nullable for historical attempts; they must be reconciled rather than guessed.
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "targetPlanDurationDays" INTEGER;
