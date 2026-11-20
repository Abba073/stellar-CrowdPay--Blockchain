-- Claim set before on-chain submission so concurrent platform approvals/rejections
-- cannot both act on the same pending withdrawal.
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS platform_claimed_at TIMESTAMPTZ;
