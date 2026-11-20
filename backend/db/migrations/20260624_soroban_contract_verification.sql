-- Track real Soroban contract state. on_chain is true only when soroban_status = 'verified'.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS soroban_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (soroban_status IN ('pending', 'verified', 'failed'));

-- Backfill: every pre-existing contract ID was fabricated ("C" + random hex) and never
-- deployed, so clear them and return those campaigns to the pending state.
UPDATE campaigns
SET escrow_contract_id = NULL,
    milestones_contract_id = NULL,
    soroban_status = 'pending'
WHERE escrow_contract_id IS NOT NULL OR milestones_contract_id IS NOT NULL;
