-- MEKANIX — Add refundToken to WithdrawalRequest
--
-- This field stores a unique token per refund attempt. When a refund is
-- executed via D1 batch(), the token is written in stmt1 (status transition)
-- and verified in stmt2 (balance increment) and stmt3 (ledger insert).
--
-- This prevents double-refund in concurrent requests:
--   - Request A: stmt1 sets refundToken='tokenA', status='REJECTED'
--   - Request B: stmt1 affects 0 rows (status already REJECTED)
--   - Request B: stmt2 checks refundToken='tokenB' → FALSE (token is 'tokenA')
--   - Request B: stmt2 affects 0 rows → NO balance increment
--
-- Without this token, stmt2 could check status='REJECTED' and succeed
-- even if THIS request didn't perform the transition — leading to
-- double-refund when the unique index on ledger only prevents duplicate
-- ledger entries, not duplicate balance increments.

ALTER TABLE "WithdrawalRequest" ADD COLUMN "refundToken" TEXT;
