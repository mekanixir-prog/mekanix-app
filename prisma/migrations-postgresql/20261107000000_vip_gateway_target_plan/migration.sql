-- Bind a VIP simulator attempt to the exact server-priced plan.
-- Nullable for historical gateway logs; legacy rows remain unbound and cannot activate new subscriptions.
ALTER TABLE "PaymentGatewayLog" ADD COLUMN "targetPlanId" TEXT;
CREATE INDEX "PaymentGatewayLog_targetPlanId_idx" ON "PaymentGatewayLog"("targetPlanId");
