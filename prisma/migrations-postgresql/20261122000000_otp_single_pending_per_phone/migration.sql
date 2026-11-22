-- Invalidate any in-flight challenges once when installing the invariant.
-- This is intentionally fail-closed: users request a fresh OTP after deployment.
UPDATE "OtpCode"
SET "consumed" = TRUE
WHERE "consumed" = FALSE;

-- At most one unconsumed challenge may exist for a canonical phone number.
-- This database constraint closes the concurrent send race across all app isolates.
CREATE UNIQUE INDEX "OtpCode_one_pending_per_phone_idx"
ON "OtpCode"("phone")
WHERE "consumed" = FALSE;
