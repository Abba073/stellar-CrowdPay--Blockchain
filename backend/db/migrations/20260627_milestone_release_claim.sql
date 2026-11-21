-- Claim + reconciliation state for milestone releases, so concurrent approvals
-- cannot both submit an on-chain payout and a failed DB commit can be recovered.
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS release_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS release_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS release_signed_xdr TEXT,
  ADD COLUMN IF NOT EXISTS release_amount     NUMERIC(20, 7);
