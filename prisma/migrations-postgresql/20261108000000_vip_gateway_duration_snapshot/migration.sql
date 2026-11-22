-- Preserve the VIP entitlement duration agreed at payment initiation.
-- Nullable for historical attempts; legacy rows must be reconciled, never guessed.
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "targetPlanDurationDays" INTEGER;
