-- Marks an SEP-24 deposit whose custodial contribution is being submitted, so
-- concurrent status polls cannot each submit an on-chain contribution.
ALTER TABLE anchor_deposits
  ADD COLUMN IF NOT EXISTS contribution_submitting_at TIMESTAMPTZ;
